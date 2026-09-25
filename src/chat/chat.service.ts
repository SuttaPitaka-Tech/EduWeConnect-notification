import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource, MoreThan } from 'typeorm';
import { Conversation, Participant, Message, Attachment } from './entities';
import { CreateGroupDto, DirectChatDto, SendMessageDto } from './dto/chat.dto';
import { MinioService } from '../minio/minio.service';
import { canUsersChat, sortContactsByRoleHierarchy, normalizeRole } from './chat-permissions';
import { NotificationsService } from '../notifications/notifications.service';

export interface UserContext {
  id: string;
  name: string;
  role: string;
  organizationId?: string | null;
}

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  private readonly minioFolder = process.env.MINIO_CHAT_FOLDER || 'chat-files';

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Participant)
    private readonly participantRepo: Repository<Participant>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(Attachment)
    private readonly attachmentRepo: Repository<Attachment>,
    private readonly dataSource: DataSource,
    private readonly minioService: MinioService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * OnModuleInit lifecycle hook
   */
  async onModuleInit() {
    this.logger.log('ChatService initialized. Real-time chat & MinIO storage ready.');
  }

  /**
   * Retrieves all conversations for a user (Channels & Direct Messages)
   */
  async getUserConversations(userId: string, organizationId?: string | null): Promise<any[]> {
    // 1. Fetch user's direct memberships that are not hidden
    const userMemberships = await this.participantRepo.find({
      where: { user_id: userId, is_hidden: false },
    });
    const userConvIds = userMemberships.map((m) => m.conversation_id);
    const membershipMap = new Map<string, Participant>();
    for (const m of userMemberships) {
      membershipMap.set(m.conversation_id, m);
    }

    // 2. Fetch public channels relevant to user's organization if provided
    let publicConvIds: string[] = [];
    if (organizationId) {
      const publicChannels = await this.conversationRepo.find({
        where: { type: 'channel', is_private: false, organization_id: organizationId },
      });
      publicConvIds = publicChannels.map((c) => c.id);
    }

    const allConversationIds = Array.from(new Set([...userConvIds, ...publicConvIds]));

    if (allConversationIds.length === 0) {
      return [];
    }

    const conversations = await this.conversationRepo.find({
      where: { id: In(allConversationIds) },
      relations: ['participants'],
      order: { last_message_at: 'DESC', created_at: 'DESC' },
    });

    // Batch-fetch latest message for each conversation in a single optimized query (eliminates N+1 DB calls)
    const latestMessages = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(
        (qb) =>
          qb
            .select('m2.conversation_id', 'conv_id')
            .addSelect('MAX(m2.created_at)', 'max_created_at')
            .from(Message, 'm2')
            .where('m2.conversation_id IN (:...convIds)', { convIds: allConversationIds })
            .andWhere('m2.is_deleted = :isDeleted', { isDeleted: false })
            .groupBy('m2.conversation_id'),
        'latest',
        'm.conversation_id = latest.conv_id AND m.created_at = latest.max_created_at',
      )
      .getMany();

    const lastMessageMap = new Map<string, Message>();
    for (const msg of latestMessages) {
      lastMessageMap.set(msg.conversation_id, msg);
    }

    const unreadCounts = await this.messageRepo
      .createQueryBuilder('m')
      .select('m.conversation_id', 'conv_id')
      .addSelect('COUNT(*)', 'cnt')
      .where('m.conversation_id IN (:...convIds)', { convIds: allConversationIds })
      .andWhere('m.sender_id != :userId', { userId })
      .andWhere('m.status != :readStatus', { readStatus: 'read' })
      .andWhere('m.is_deleted = :isDeleted', { isDeleted: false })
      .groupBy('m.conversation_id')
      .getRawMany();

    const unreadMap = new Map<string, number>();
    for (const row of unreadCounts) {
      unreadMap.set(row.conv_id, Number(row.cnt) || 0);
    }

    // Batch query participant emails from user_roles
    const allParticipantUserIds = Array.from(
      new Set(conversations.flatMap((c) => c.participants.map((p) => p.user_id))),
    );
    const emailMap = new Map<string, string>();
    if (allParticipantUserIds.length > 0) {
      try {
        const userRoleRows = await this.dataSource.query(
          `SELECT user_id, email_id FROM \`role-allocation-service\`.user_roles WHERE user_id IN (?)`,
          [allParticipantUserIds],
        );
        for (const row of userRoleRows) {
          if (row.user_id && row.email_id) {
            emailMap.set(row.user_id, row.email_id);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Could not fetch emails for participants: ${err.message}`);
      }
    }

    // Batch query organization names for all participants
    const orgMap = new Map<string, string>();
    if (allParticipantUserIds.length > 0) {
      try {
        const staffOrgs = await this.dataSource.query(
          `SELECT sd.id AS staff_id, ur.user_id, od.organization_name
           FROM \`role-allocation-service\`.staff_details sd
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = sd.employee_email OR ur.user_id = sd.id)
           INNER JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = sd.organization_id
           WHERE ur.user_id IN (?) OR sd.id IN (?)`,
          [allParticipantUserIds, allParticipantUserIds],
        );
        for (const row of staffOrgs) {
          if (row.user_id && row.organization_name) orgMap.set(row.user_id, row.organization_name);
          if (row.staff_id && row.organization_name) orgMap.set(row.staff_id, row.organization_name);
        }

        const studentOrgs = await this.dataSource.query(
          `SELECT st.id AS student_id, ur.user_id, od.organization_name
           FROM \`role-allocation-service\`.student_details st
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.user_id = st.id OR ur.email_id = st.contact_email)
           INNER JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = st.organization_id
           WHERE ur.user_id IN (?) OR st.id IN (?)`,
          [allParticipantUserIds, allParticipantUserIds],
        );
        for (const row of studentOrgs) {
          if (row.user_id && row.organization_name) orgMap.set(row.user_id, row.organization_name);
          if (row.student_id && row.organization_name) orgMap.set(row.student_id, row.organization_name);
        }

        const orgDirect = await this.dataSource.query(
          `SELECT od.id AS org_id, ur.user_id, od.organization_name
           FROM \`role-allocation-service\`.\`organization-details\` od
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = od.organization_email OR ur.user_id = od.id)
           WHERE ur.user_id IN (?) OR od.id IN (?)`,
          [allParticipantUserIds, allParticipantUserIds],
        );
        for (const row of orgDirect) {
          if (row.user_id && row.organization_name) orgMap.set(row.user_id, row.organization_name);
          if (row.org_id && row.organization_name) orgMap.set(row.org_id, row.organization_name);
        }
      } catch (err: any) {
        this.logger.warn(`Could not fetch organization names: ${err.message}`);
      }
    }

    const result = conversations.map((conv) => {
      const myMembership = membershipMap.get(conv.id);
      const lastMessage = lastMessageMap.get(conv.id);
      const otherParticipants = conv.participants.filter((p) => p.user_id !== userId);

      const isCleared =
        myMembership?.cleared_at &&
        lastMessage?.created_at &&
        new Date(lastMessage.created_at).getTime() <= new Date(myMembership.cleared_at).getTime();
      const effectiveLastMessage = isCleared ? null : lastMessage;

      let displayName = conv.name || 'Chat';
      let roleSubtitle = conv.topic || `${conv.participants.length} members`;
      let contactEmail: string | null = null;
      let contactOrgName: string | null = null;

      if (conv.type === 'direct' && otherParticipants.length > 0) {
        displayName = otherParticipants[0].user_name;
        roleSubtitle = otherParticipants[0].user_role;
        contactEmail = emailMap.get(otherParticipants[0].user_id) || null;
        contactOrgName = orgMap.get(otherParticipants[0].user_id) || null;
      }

      const timestamp =
        effectiveLastMessage?.created_at?.getTime() ||
        conv.last_message_at?.getTime() ||
        conv.created_at?.getTime() ||
        0;

      return {
        id: conv.id,
        type: conv.type,
        name: displayName,
        email: contactEmail,
        organizationName: contactOrgName,
        topic: conv.topic,
        isPrivate: conv.is_private,
        role: conv.type === 'direct' ? roleSubtitle : undefined,
        subtitle: roleSubtitle,
        unreadCount: isCleared ? 0 : (unreadMap.get(conv.id) || 0),
        lastMessage: effectiveLastMessage?.content || null,
        lastMessageTime: effectiveLastMessage
          ? effectiveLastMessage.created_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : null,
        lastMessageTimestamp: timestamp,
        participants: conv.participants.map((p) => ({
          id: p.user_id,
          name: p.user_name,
          role: p.user_role,
          email: emailMap.get(p.user_id) || null,
          organizationName: orgMap.get(p.user_id) || null,
          isAdmin: p.is_admin,
        })),
      };
    });

    result.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));

    return result;
  }

  /**
   * Retrieves participant user IDs (and mapped organization IDs) for a conversation
   */
  async getParticipantUserIds(conversationId: string): Promise<string[]> {
    const parts = await this.participantRepo.find({
      where: { conversation_id: conversationId },
      select: ['user_id'],
    });
    const ids = new Set<string>();
    for (const p of parts) {
      if (p.user_id) {
        ids.add(p.user_id);
        try {
          const orgId = await this.resolveUserOrganization(p.user_id);
          if (orgId) {
            ids.add(orgId);
          }
        } catch {}
      }
    }
    return Array.from(ids);
  }

  /**
   * Verifies if a user has access to a conversation (direct, private, or public)
   */
  async canUserAccessConversation(
    conversationOrId: string | Conversation,
    user: UserContext,
  ): Promise<boolean> {
    const conv =
      typeof conversationOrId === 'string'
        ? await this.conversationRepo.findOne({
            where: { id: conversationOrId },
            relations: ['participants'],
          })
        : conversationOrId;
    if (!conv) return false;

    // Direct chats and private conversations are accessible to participants or mapped org admin
    const userOrgId = user.organizationId || (await this.resolveUserOrganization(user.id));
    const isParticipant = conv.participants?.some(
      (p) =>
        p.user_id === user.id ||
        (userOrgId && p.user_id === userOrgId) ||
        (user.organizationId && p.user_id === user.organizationId),
    );
    if (isParticipant) return true;

    if (conv.type === 'direct' || conv.is_private) {
      return false;
    }

    // Public channels are accessible to members of the same organization (or global if no org)
    if (conv.type === 'channel' && !conv.is_private) {
      return !conv.organization_id || conv.organization_id === user.organizationId || conv.organization_id === userOrgId;
    }

    return false;
  }

  /**
   * Fetches paginated messages for a conversation
   */
  async getConversationMessages(
    conversationId: string,
    userContext?: UserContext,
    page = 1,
    limit = 50,
  ): Promise<any[]> {
    const conv = await this.conversationRepo.findOne({
      where: { id: conversationId },
      relations: ['participants'],
    });
    if (!conv) {
      throw new NotFoundException(`Conversation with ID ${conversationId} not found`);
    }

    let clearedAt: Date | null = null;
    if (userContext) {
      const allowed = await this.canUserAccessConversation(conv, userContext);
      if (!allowed) {
        throw new ForbiddenException('You do not have permission to view this conversation');
      }
      const participant = conv.participants?.find((p) => p.user_id === userContext.id);
      if (participant?.cleared_at) {
        clearedAt = participant.cleared_at;
      }
    }

    const whereCondition: any = { conversation_id: conversationId, is_deleted: false };
    if (clearedAt) {
      whereCondition.created_at = MoreThan(clearedAt);
    }

    const messages = await this.messageRepo.find({
      where: whereCondition,
      relations: ['attachments'],
      order: { created_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Build quick lookup for replying parents
    const msgMap = new Map(messages.map((m) => [m.id, m]));

    // Batch query sender emails and organizations from user_roles
    const senderIds = Array.from(new Set(messages.map((m) => m.sender_id)));
    const senderEmailMap = new Map<string, string>();
    const senderOrgMap = new Map<string, string>();
    if (senderIds.length > 0) {
      try {
        const rows = await this.dataSource.query(
          `SELECT user_id, email_id FROM \`role-allocation-service\`.user_roles WHERE user_id IN (?)`,
          [senderIds],
        );
        for (const r of rows) {
          if (r.user_id && r.email_id) senderEmailMap.set(r.user_id, r.email_id);
        }

        const staffOrgs = await this.dataSource.query(
          `SELECT sd.id AS staff_id, ur.user_id, od.organization_name
           FROM \`role-allocation-service\`.staff_details sd
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = sd.employee_email OR ur.user_id = sd.id)
           INNER JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = sd.organization_id
           WHERE ur.user_id IN (?) OR sd.id IN (?)`,
          [senderIds, senderIds],
        );
        for (const row of staffOrgs) {
          if (row.user_id && row.organization_name) senderOrgMap.set(row.user_id, row.organization_name);
          if (row.staff_id && row.organization_name) senderOrgMap.set(row.staff_id, row.organization_name);
        }

        const studentOrgs = await this.dataSource.query(
          `SELECT st.id AS student_id, ur.user_id, od.organization_name
           FROM \`role-allocation-service\`.student_details st
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.user_id = st.id OR ur.email_id = st.contact_email)
           INNER JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = st.organization_id
           WHERE ur.user_id IN (?) OR st.id IN (?)`,
          [senderIds, senderIds],
        );
        for (const row of studentOrgs) {
          if (row.user_id && row.organization_name) senderOrgMap.set(row.user_id, row.organization_name);
          if (row.student_id && row.organization_name) senderOrgMap.set(row.student_id, row.organization_name);
        }

        const orgDirect = await this.dataSource.query(
          `SELECT od.id AS org_id, ur.user_id, od.organization_name
           FROM \`role-allocation-service\`.\`organization-details\` od
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = od.organization_email OR ur.user_id = od.id)
           WHERE ur.user_id IN (?) OR od.id IN (?)`,
          [senderIds, senderIds],
        );
        for (const row of orgDirect) {
          if (row.user_id && row.organization_name) senderOrgMap.set(row.user_id, row.organization_name);
          if (row.org_id && row.organization_name) senderOrgMap.set(row.org_id, row.organization_name);
        }
      } catch (err: any) {
        this.logger.warn(`Could not fetch sender metadata: ${err.message}`);
      }
    }

    // Populate pre-signed URLs for any MinIO attachments
    return Promise.all(
      messages.map(async (msg) => {
        const enrichedAttachments = await Promise.all(
          (msg.attachments || []).map(async (att) => {
            let fileUrl = att.url;
            if (!fileUrl && att.storage_key) {
              try {
                fileUrl = await this.minioService.getFileUrl(att.storage_key);
              } catch (err: any) {
                this.logger.warn(`Failed to generate signed url for ${att.storage_key}: ${err.message}`);
              }
            }
            return {
              id: att.id,
              name: att.file_name,
              type: att.file_type,
              size: att.file_size,
              url: fileUrl,
              storageKey: att.storage_key,
            };
          }),
        );

        let replyTo: { id: string; senderName: string; content: string } | null = null;
        if (msg.reply_to_id) {
          const parent = msgMap.get(msg.reply_to_id);
          if (parent) {
            replyTo = {
              id: parent.id,
              senderName: parent.sender_name,
              content: parent.content,
            };
          } else {
            const fetchedParent = await this.messageRepo.findOne({ where: { id: msg.reply_to_id } });
            if (fetchedParent) {
              replyTo = {
                id: fetchedParent.id,
                senderName: fetchedParent.sender_name,
                content: fetchedParent.content,
              };
            }
          }
        }

        return {
          id: msg.id,
          conversationId: msg.conversation_id,
          senderId: msg.sender_id,
          senderName: msg.sender_name,
          senderRole: msg.sender_role,
          senderEmail: senderEmailMap.get(msg.sender_id) || null,
          senderOrganizationName: senderOrgMap.get(msg.sender_id) || null,
          content: msg.content,
          messageType: msg.message_type,
          status: msg.status || 'sent',
          deliveredAt: msg.delivered_at,
          readAt: msg.read_at,
          reactions: msg.reactions || {},
          replyToId: msg.reply_to_id,
          replyTo,
          isPinned: Boolean(msg.is_pinned),
          isEdited: Boolean(msg.is_edited),
          timestamp: msg.created_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          createdAt: msg.created_at,
          attachments: enrichedAttachments,
        };
      }),
    );
  }

  /**
   * Creates a new Group / Channel with participants
   */
  async createGroup(dto: CreateGroupDto, creator: UserContext): Promise<any> {
    if (!dto.name || !dto.name.trim()) {
      throw new BadRequestException('Group name is required');
    }

    const cleanName = dto.name.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');

    const conversation = this.conversationRepo.create({
      type: 'channel',
      name: cleanName,
      topic: dto.topic?.trim() || null,
      is_private: dto.is_private ?? false,
      created_by: creator.id,
      organization_id: dto.organization_id || creator.organizationId || null,
      last_message_at: new Date(),
    });

    const savedConv = await this.conversationRepo.save(conversation);

    // Add creator as Admin participant
    const creatorParticipant = this.participantRepo.create({
      conversation_id: savedConv.id,
      user_id: creator.id,
      user_role: creator.role,
      user_name: creator.name,
      is_admin: true,
    });

    const participantsToSave = [creatorParticipant];

    // Add other selected member IDs
    if (dto.member_ids && dto.member_ids.length > 0) {
      const distinctMembers = Array.from(new Set(dto.member_ids.filter((id) => id !== creator.id)));
      for (const mId of distinctMembers) {
        participantsToSave.push(
          this.participantRepo.create({
            conversation_id: savedConv.id,
            user_id: mId,
            user_role: 'member',
            user_name: `Member ${mId.slice(0, 5)}`,
            is_admin: false,
          }),
        );
      }
    }

    await this.participantRepo.save(participantsToSave);

    // Save initial message if provided
    if (dto.initial_message && dto.initial_message.trim()) {
      const initMsg = this.messageRepo.create({
        conversation_id: savedConv.id,
        sender_id: creator.id,
        sender_name: creator.name,
        sender_role: creator.role,
        content: dto.initial_message.trim(),
        message_type: 'text',
      });
      await this.messageRepo.save(initMsg);
    }

    return {
      id: savedConv.id,
      type: savedConv.type,
      name: savedConv.name,
      topic: savedConv.topic,
      isPrivate: savedConv.is_private,
      participantsCount: participantsToSave.length,
      createdAt: savedConv.created_at,
    };
  }

  /**
   * Initializes or gets an existing 1-on-1 Direct Chat
   */
  async getOrCreateDirectChat(sender: UserContext, recipient: DirectChatDto): Promise<any> {
    if (sender.id === recipient.recipient_id) {
      throw new BadRequestException('Cannot start a direct chat with yourself');
    }

    // 1. Check if direct conversation already exists between sender and recipient
    // (e.g. unhide a previously hidden conversation)
    const senderMemberships = await this.participantRepo.find({
      where: { user_id: sender.id },
    });
    const senderConvIds = senderMemberships.map((m) => m.conversation_id);

    if (senderConvIds.length > 0) {
      const sharedMembership = await this.participantRepo.findOne({
        where: {
          conversation_id: In(senderConvIds),
          user_id: recipient.recipient_id,
        },
        relations: ['conversation'],
      });

      if (sharedMembership && sharedMembership.conversation?.type === 'direct') {
        // Unhide for sender if it was hidden
        await this.participantRepo.update(
          { conversation_id: sharedMembership.conversation.id, user_id: sender.id },
          { is_hidden: false },
        );
        return {
          id: sharedMembership.conversation.id,
          type: 'direct',
          recipientName: recipient.recipient_name,
          recipientRole: recipient.recipient_role,
        };
      }
    }

    // 2. Resolve organizations and validate permission for new direct chat
    const senderOrgId = sender.organizationId || (await this.resolveUserOrganization(sender.id));
    const recipientOrgId = await this.resolveUserOrganization(recipient.recipient_id);

    const isPermitted = canUsersChat(
      { id: sender.id, role: sender.role, organizationId: senderOrgId },
      { id: recipient.recipient_id, userId: recipient.recipient_id, role: recipient.recipient_role, organizationId: recipientOrgId },
    );

    if (!isPermitted) {
      throw new ForbiddenException(
        'Cross-organization direct messaging is not permitted for your role',
      );
    }

    // 3. Create new direct conversation
    const conv = this.conversationRepo.create({
      type: 'direct',
      is_private: true,
      created_by: sender.id,
      organization_id: senderOrgId || null,
      last_message_at: new Date(),
    });
    const savedConv = await this.conversationRepo.save(conv);

    // Add both participants
    const p1 = this.participantRepo.create({
      conversation_id: savedConv.id,
      user_id: sender.id,
      user_role: sender.role,
      user_name: sender.name,
      is_admin: true,
    });
    const p2 = this.participantRepo.create({
      conversation_id: savedConv.id,
      user_id: recipient.recipient_id,
      user_role: recipient.recipient_role,
      user_name: recipient.recipient_name,
      is_admin: false,
    });
    await this.participantRepo.save([p1, p2]);

    return {
      id: savedConv.id,
      type: 'direct',
      recipientName: recipient.recipient_name,
      recipientRole: recipient.recipient_role,
    };
  }

  /**
   * Saves a message and associated attachments to MySQL
   */
  async saveMessage(
    dto: SendMessageDto,
    sender: UserContext,
    initialStatus: 'sent' | 'delivered' | 'read' = 'sent',
  ): Promise<any> {
    if (!dto.content?.trim() && (!dto.attachments || dto.attachments.length === 0)) {
      throw new BadRequestException('Message content or attachment required');
    }

    const conversation = await this.conversationRepo.findOne({
      where: { id: dto.conversation_id },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${dto.conversation_id} not found`);
    }

    const now = new Date();

    let normalizedType: 'text' | 'file' | 'system' = 'text';
    if (
      dto.message_type === 'file' ||
      (dto.message_type as string) === 'image' ||
      (dto.attachments && dto.attachments.length > 0)
    ) {
      normalizedType = 'file';
    } else if (dto.message_type === 'system') {
      normalizedType = 'system';
    }

    const message = this.messageRepo.create({
      conversation_id: dto.conversation_id,
      sender_id: sender.id,
      sender_name: sender.name,
      sender_role: sender.role,
      content: dto.content?.trim() || '',
      message_type: normalizedType,
      reply_to_id: dto.reply_to_id || null,
      status: initialStatus,
      delivered_at: initialStatus !== 'sent' ? now : null,
      read_at: initialStatus === 'read' ? now : null,
    });

    const savedMessage = await this.messageRepo.save(message);

    // Save attachments in database
    let savedAttachments: Attachment[] = [];
    if (dto.attachments && dto.attachments.length > 0) {
      const attachments = dto.attachments.map((att) =>
        this.attachmentRepo.create({
          message_id: savedMessage.id,
          file_name: att.file_name,
          file_type: att.file_type,
          file_size: att.file_size,
          storage_key: att.storage_key || '',
          url: att.url || null,
        }),
      );
      savedAttachments = await this.attachmentRepo.save(attachments);
    }

    // Update conversation last_message_at
    await this.conversationRepo.update(conversation.id, {
      last_message_at: now,
    });

    // Unhide conversation for participants if it was hidden
    await this.participantRepo.update(
      { conversation_id: conversation.id, is_hidden: true },
      { is_hidden: false },
    );

    // Create privacy-safe notification alert for other participants
    try {
      const participants = await this.participantRepo.find({
        where: { conversation_id: conversation.id },
      });
      for (const p of participants) {
        if (p.user_id !== sender.id) {
          // Check role permissions: who can chat with who
          const permitted = canUsersChat(
            { id: sender.id, role: sender.role, organizationId: sender.organizationId },
            { userId: p.user_id, role: p.user_role, organizationId: sender.organizationId },
          );
          if (permitted) {
            await this.notificationsService.createChatAlert({
              recipientId: p.user_id,
              senderId: sender.id,
              senderName: sender.name,
              senderRole: sender.role,
              organizationName: sender.organizationId || null,
              conversationId: conversation.id,
            });
          }
        }
      }
    } catch (notifErr: any) {
      this.logger.warn(`Failed to create notification alert: ${notifErr.message}`);
    }

    let replyTo: { id: string; senderName: string; content: string } | null = null;
    if (savedMessage.reply_to_id) {
      const parent = await this.messageRepo.findOne({ where: { id: savedMessage.reply_to_id } });
      if (parent) {
        replyTo = {
          id: parent.id,
          senderName: parent.sender_name,
          content: parent.content,
        };
      }
    }

    return {
      id: savedMessage.id,
      conversationId: savedMessage.conversation_id,
      senderId: savedMessage.sender_id,
      senderName: savedMessage.sender_name,
      senderRole: savedMessage.sender_role,
      content: savedMessage.content,
      messageType: savedMessage.message_type,
      reactions: {},
      status: savedMessage.status,
      deliveredAt: savedMessage.delivered_at,
      readAt: savedMessage.read_at,
      replyToId: savedMessage.reply_to_id,
      replyTo,
      isPinned: false,
      isEdited: false,
      timestamp: savedMessage.created_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: savedMessage.created_at,
      attachments: savedAttachments.map((a) => ({
        id: a.id,
        name: a.file_name,
        type: a.file_type,
        size: a.file_size,
        url: a.url,
        storageKey: a.storage_key,
      })),
    };
  }

  /**
   * Uploads raw media/files/images directly to MinIO under chat-files/ folder
   * Strictly enforces 2MB maximum file size limit
   */
  async uploadAttachmentToMinio(
    file: Express.Multer.File,
    conversationId: string,
  ): Promise<{
    file_name: string;
    file_type: string;
    file_size: string;
    storage_key: string;
    url: string;
  }> {
    const MAX_SIZE = 2 * 1024 * 1024; // 2MB limit
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File size exceeds the maximum limit of 2MB');
    }

    const cleanFileName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `chat-files/${conversationId}/${Date.now()}_${cleanFileName}`;

    await this.minioService.uploadFile(file.buffer, storageKey, file.mimetype);
    const signedUrl = await this.minioService.getFileUrl(storageKey);

    const sizeInMb = (file.size / (1024 * 1024)).toFixed(1);
    const sizeStr = file.size > 1024 * 1024 ? `${sizeInMb} MB` : `${Math.round(file.size / 1024)} KB`;

    return {
      file_name: file.originalname,
      file_type: file.mimetype,
      file_size: sizeStr,
      storage_key: storageKey,
      url: signedUrl,
    };
  }

  /**
   * Toggles emoji reaction on message
   */
  async toggleReaction(messageId: string, emoji: string): Promise<any> {
    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    const reactions = msg.reactions || {};
    reactions[emoji] = (reactions[emoji] || 0) + 1;

    msg.reactions = reactions;
    await this.messageRepo.save(msg);
    return { messageId, reactions };
  }

  /**
   * Edits message content
   */
  async editMessage(messageId: string, newContent: string, user: UserContext): Promise<any> {
    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    if (msg.sender_id !== user.id && user.role !== 'super_admin') {
      throw new ForbiddenException('You can only edit your own messages');
    }

    msg.content = newContent.trim();
    msg.is_edited = true;
    msg.edited_at = new Date();

    await this.messageRepo.save(msg);

    return {
      messageId: msg.id,
      conversationId: msg.conversation_id,
      content: msg.content,
      isEdited: true,
      editedAt: msg.edited_at,
    };
  }

  /**
   * Deletes a message permanently from the database
   */
  async deleteMessage(messageId: string, user: UserContext): Promise<any> {
    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    if (msg.sender_id !== user.id && user.role !== 'super_admin' && user.role !== 'institution_admin') {
      throw new ForbiddenException('You can only delete your own messages');
    }

    const conversationId = msg.conversation_id;

    // 1. Fetch associated attachments to permanently delete them from MinIO
    const attachments = await this.attachmentRepo.find({ where: { message_id: messageId } });
    for (const att of attachments) {
      if (att.storage_key) {
        try {
          await this.minioService.deleteFile(att.storage_key);
          this.logger.log(`Deleted attachment from MinIO: ${att.storage_key}`);
        } catch (minioErr: any) {
          this.logger.warn(`Failed to delete MinIO attachment ${att.storage_key}: ${minioErr.message}`);
        }
      }
    }

    // 2. Delete associated attachments from database
    await this.attachmentRepo.delete({ message_id: messageId });

    // 3. Clear any replies pointing to this message
    await this.messageRepo.update({ reply_to_id: messageId }, { reply_to_id: null });

    // 4. Delete the message record permanently from the database table
    await this.messageRepo.delete(messageId);

    return {
      messageId: msg.id,
      conversationId: conversationId,
      isDeleted: true,
    };
  }

  /**
   * Toggles pin status for a message
   */
  async togglePinMessage(messageId: string): Promise<any> {
    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    msg.is_pinned = !msg.is_pinned;
    await this.messageRepo.save(msg);

    return {
      messageId: msg.id,
      conversationId: msg.conversation_id,
      isPinned: msg.is_pinned,
    };
  }

  /**
   * Retrieves real users / contacts from role-allocation-service database
   * (Admins, Organization, Staff/Teachers, Students)
   */
  /**
   * Resolves a user's associated organizationId by checking staff_details, student_details, and organization-details
   */
  async resolveUserOrganization(userId: string): Promise<string | null> {
    if (!userId) return null;
    try {
      // 1. Check staff_details (matching sd.id, sd.employee_email, or joined ur.user_id / ur.email_id)
      const staffRows = await this.dataSource.query(
        `SELECT sd.organization_id FROM \`role-allocation-service\`.staff_details sd
         LEFT JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = sd.employee_email OR ur.user_id = sd.id)
         WHERE sd.id = ? OR sd.employee_email = ? OR ur.user_id = ? OR ur.email_id = ?
         LIMIT 1`,
        [userId, userId, userId, userId],
      );
      if (staffRows.length > 0 && staffRows[0].organization_id) {
        return staffRows[0].organization_id;
      }

      // 2. Check student_details (matching st.id, st.contact_email, or joined ur.user_id / ur.email_id)
      const studentRows = await this.dataSource.query(
        `SELECT st.organization_id FROM \`role-allocation-service\`.student_details st
         LEFT JOIN \`role-allocation-service\`.user_roles ur ON (ur.user_id = st.id OR ur.email_id = st.contact_email)
         WHERE st.id = ? OR st.contact_email = ? OR ur.user_id = ? OR ur.email_id = ?
         LIMIT 1`,
        [userId, userId, userId, userId],
      );
      if (studentRows.length > 0 && studentRows[0].organization_id) {
        return studentRows[0].organization_id;
      }

      // 3. Check organization-details (matching od.id, od.organization_email, or joined ur.user_id / ur.email_id)
      const orgRows = await this.dataSource.query(
        `SELECT od.id FROM \`role-allocation-service\`.\`organization-details\` od
         LEFT JOIN \`role-allocation-service\`.user_roles ur ON (od.organization_email = ur.email_id OR od.id = ur.user_id)
         WHERE od.id = ? OR od.organization_email = ? OR ur.user_id = ? OR ur.email_id = ?
         LIMIT 1`,
        [userId, userId, userId, userId],
      );
      if (orgRows.length > 0 && orgRows[0].id) {
        return orgRows[0].id;
      }

      // 4. Check user_roles table if linked to an org
      const userRoles = await this.dataSource.query(
        `SELECT od.id AS org_id FROM \`role-allocation-service\`.user_roles ur
         INNER JOIN \`role-allocation-service\`.\`organization-details\` od ON (od.organization_email = ur.email_id OR od.id = ur.user_id)
         WHERE ur.user_id = ? OR ur.email_id = ? LIMIT 1`,
        [userId, userId],
      );
      if (userRoles.length > 0 && userRoles[0].org_id) {
        return userRoles[0].org_id;
      }
    } catch (e: any) {
      this.logger.warn(`Failed to resolve user organization for ${userId}: ${e.message}`);
    }
    return null;
  }

  /**
   * Retrieves real users / contacts from role-allocation-service database
   * Enforces cross-organization eligibility and arranges members by strict hierarchy:
   * 1. Super Admin
   * 2. Organization (Institution Admin)
   * 3. Staff / Teachers
   * 4. Students
   */
  async getChatContacts(user: UserContext, search?: string): Promise<any[]> {
    try {
      // 1. Resolve user's organizationId
      let orgId = user.organizationId;
      if (!orgId) {
        orgId = await this.resolveUserOrganization(user.id);
      }

      const userRole = normalizeRole(user.role);
      const isSuperAdmin = userRole === 'super_admin';
      const isOrgAdmin = userRole === 'institution_admin';

      const contacts: any[] = [];

      // 2. Fetch Super Admins (Visible to everyone)
      const admins = await this.dataSource.query(
        `SELECT ur.user_id, ur.email_id, 'super_admin' AS role_name
         FROM \`role-allocation-service\`.user_roles ur
         WHERE ur.role_name = 'super_admin'`,
      );
      for (const a of admins) {
        if (a.user_id !== user.id) {
          const emailPrefix = a.email_id?.split('@')[0] || '';
          contacts.push({
            id: a.user_id,
            userId: a.user_id,
            name: a.email_id === 'admin@gmail.com' ? 'System Administrator' : `Admin (${emailPrefix})`,
            email: a.email_id,
            role: 'Super Admin',
            organizationId: null,
            category: 'Admins',
            status: 'online',
          });
        }
      }

      // 3. Fetch Organization (Institution Admin)
      // - Super Admin & Organization Admins: can see all approved Organization Heads (cross-org head communication)
      // - Staff & Students: can ONLY see their own Organization Head
      if (isSuperAdmin || isOrgAdmin) {
        const orgRows = await this.dataSource.query(
          `SELECT od.id AS org_id, ur.user_id, od.organization_name, od.organization_email, od.organization_mobile
           FROM \`role-allocation-service\`.\`organization-details\` od
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = od.organization_email OR ur.user_id = od.id)`,
        );
        for (const o of orgRows) {
          const orgUserId = o.user_id || o.org_id;
          if (orgUserId !== user.id) {
            contacts.push({
              id: orgUserId,
              userId: orgUserId,
              name: o.organization_name || 'Institution Admin',
              email: o.organization_email,
              role: 'Institution Admin',
              organizationId: o.org_id,
              organizationName: o.organization_name || 'Institution',
              category: 'Organization',
              status: 'online',
            });
          }
        }
      } else if (orgId) {
        const orgRows = await this.dataSource.query(
          `SELECT od.id AS org_id, ur.user_id, od.organization_name, od.organization_email, od.organization_mobile
           FROM \`role-allocation-service\`.\`organization-details\` od
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = od.organization_email OR ur.user_id = od.id)
           WHERE od.id = ? LIMIT 1`,
          [orgId],
        );
        if (orgRows.length > 0) {
          const o = orgRows[0];
          const orgUserId = o.user_id || o.org_id;
          if (orgUserId !== user.id) {
            contacts.push({
              id: orgUserId,
              userId: orgUserId,
              name: o.organization_name || 'Institution Admin',
              email: o.organization_email,
              role: 'Institution Admin',
              organizationId: o.org_id,
              organizationName: o.organization_name || 'Institution',
              category: 'Organization',
              status: 'online',
            });
          }
        }
      }

      // 4. Fetch Staff / Teachers
      // - Super Admin: sees all staff
      // - Organization Admins, Staff, Students: ONLY see staff under their own organization
      const staffOrgFilter = isSuperAdmin ? null : orgId;
      const staffQuery = staffOrgFilter
        ? `SELECT sd.id AS staff_id, ur.user_id, sd.employee_first_name, sd.employee_last_name, sd.employee_email, sd.employee_type,
                  sd.organization_id, od.organization_name
           FROM \`role-allocation-service\`.staff_details sd
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = sd.employee_email OR ur.user_id = sd.id)
           LEFT JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = sd.organization_id
           WHERE sd.organization_id = ?`
        : `SELECT sd.id AS staff_id, ur.user_id, sd.employee_first_name, sd.employee_last_name, sd.employee_email, sd.employee_type,
                  sd.organization_id, od.organization_name
           FROM \`role-allocation-service\`.staff_details sd
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.email_id = sd.employee_email OR ur.user_id = sd.id)
           LEFT JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = sd.organization_id`;

      const staffRows = await this.dataSource.query(staffQuery, staffOrgFilter ? [staffOrgFilter] : []);
      for (const s of staffRows) {
        const staffUserId = s.user_id || s.staff_id;
        if (staffUserId !== user.id) {
          const fullName = `${s.employee_first_name || ''} ${s.employee_last_name || ''}`.trim();
          contacts.push({
            id: staffUserId,
            userId: staffUserId,
            name: fullName || s.employee_email || 'Teacher',
            email: s.employee_email,
            role: s.employee_type || 'Teacher',
            organizationId: s.organization_id,
            organizationName: s.organization_name || null,
            category: 'Staff & Teachers',
            status: 'online',
          });
        }
      }

      // 5. Fetch Students
      // - Super Admin: sees all students
      // - Organization Admins, Staff, Students: ONLY see students under their own organization
      const studentOrgFilter = isSuperAdmin ? null : orgId;
      const studentQuery = studentOrgFilter
        ? `SELECT st.id AS student_id, ur.user_id, st.student_name, st.contact_email, st.standard,
                  st.organization_id, od.organization_name
           FROM \`role-allocation-service\`.student_details st
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.user_id = st.id OR ur.email_id = st.contact_email)
           LEFT JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = st.organization_id
           WHERE st.organization_id = ?`
        : `SELECT st.id AS student_id, ur.user_id, st.student_name, st.contact_email, st.standard,
                  st.organization_id, od.organization_name
           FROM \`role-allocation-service\`.student_details st
           INNER JOIN \`role-allocation-service\`.user_roles ur ON (ur.user_id = st.id OR ur.email_id = st.contact_email)
           LEFT JOIN \`role-allocation-service\`.\`organization-details\` od ON od.id = st.organization_id`;

      const studentRows = await this.dataSource.query(studentQuery, studentOrgFilter ? [studentOrgFilter] : []);
      for (const st of studentRows) {
        const studentUserId = st.user_id || st.student_id;
        if (studentUserId !== user.id && st.student_id !== user.id) {
          contacts.push({
            id: studentUserId,
            userId: studentUserId,
            name: st.student_name || 'Student',
            email: st.contact_email,
            role: st.standard ? `Student (${st.standard})` : 'Student',
            organizationId: st.organization_id,
            organizationName: st.organization_name || null,
            category: 'Students',
            status: 'online',
          });
        }
      }

      // 6. Sort strictly by requested role hierarchy:
      // Super Admin -> Organization -> Staff -> Students
      let sortedContacts = sortContactsByRoleHierarchy(contacts);

      // Filter by search query if provided
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        sortedContacts = sortedContacts.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.role.toLowerCase().includes(q) ||
            c.category.toLowerCase().includes(q) ||
            (c.email && c.email.toLowerCase().includes(q)),
        );
      }

      return sortedContacts;
    } catch (err: any) {
      this.logger.error(`Error querying contacts: ${err.message}`);
      return [];
    }
  }

  /**
   * Marks all messages in a conversation sent by others as read by readerId
   */
  async markConversationAsRead(
    conversationId: string,
    readerId: string,
  ): Promise<{ affected: number }> {
    const now = new Date();
    try {
      const result = await this.messageRepo
        .createQueryBuilder()
        .update(Message)
        .set({ status: 'read', read_at: now })
        .where('conversation_id = :conversationId', { conversationId })
        .andWhere('sender_id != :readerId', { readerId })
        .andWhere('status != :readStatus', { readStatus: 'read' })
        .execute();

      const latestMsg = await this.messageRepo.findOne({
        where: { conversation_id: conversationId },
        order: { created_at: 'DESC' },
      });

      if (latestMsg) {
        await this.participantRepo
          .createQueryBuilder()
          .update(Participant)
          .set({ last_read_message_id: latestMsg.id })
          .where('conversation_id = :conversationId AND user_id = :readerId', {
            conversationId,
            readerId,
          })
          .execute();
      }

      // Automatically delete alert for this conversation from notification_alert to free up space
      await this.notificationsService.deleteByConversation(conversationId, readerId);

      return { affected: result.affected || 0 };
    } catch (err: any) {
      this.logger.error(`Failed to mark conversation as read: ${err.message}`);
      return { affected: 0 };
    }
  }

  /**
   * Marks sent messages in user's conversations as delivered when user is online
   */
  async markMessagesAsDeliveredForUser(userId: string): Promise<string[]> {
    try {
      const userConversations = await this.participantRepo.find({
        where: { user_id: userId },
        select: ['conversation_id'],
      });
      if (!userConversations || userConversations.length === 0) return [];

      const convIds = userConversations.map((c) => c.conversation_id);
      const now = new Date();

      await this.messageRepo
        .createQueryBuilder()
        .update(Message)
        .set({ status: 'delivered', delivered_at: now })
        .where('conversation_id IN (:...convIds)', { convIds })
        .andWhere('sender_id != :userId', { userId })
        .andWhere('status = :sentStatus', { sentStatus: 'sent' })
        .execute();

      return convIds;
    } catch (err: any) {
      this.logger.error(`Failed to mark messages as delivered: ${err.message}`);
      return [];
    }
  }

  /**
   * Clears conversation history for the requesting user (does NOT affect the other user)
   */
  async clearChatHistory(conversationId: string, user: UserContext): Promise<any> {
    const participant = await this.participantRepo.findOne({
      where: { conversation_id: conversationId, user_id: user.id },
    });
    if (!participant) {
      throw new NotFoundException('Participant record not found for this conversation');
    }

    const now = new Date();
    participant.cleared_at = now;
    participant.is_hidden = true;
    await this.participantRepo.save(participant);

    return {
      status: 'success',
      message: 'Chat history cleared for user',
      conversationId,
      clearedAt: now,
    };
  }

  /**
   * Hides the conversation from the user's sidebar
   */
  async hideChat(conversationId: string, user: UserContext): Promise<any> {
    const participant = await this.participantRepo.findOne({
      where: { conversation_id: conversationId, user_id: user.id },
    });
    if (!participant) {
      throw new NotFoundException('Participant record not found for this conversation');
    }

    participant.is_hidden = true;
    await this.participantRepo.save(participant);

    return {
      status: 'success',
      message: 'Chat hidden for user',
      conversationId,
    };
  }
}

