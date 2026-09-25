import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationAlert } from './entities/notification-alert.entity';

export interface CreateChatAlertDto {
  recipientId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  organizationName?: string | null;
  conversationId: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(NotificationAlert)
    private readonly alertRepo: Repository<NotificationAlert>,
  ) {}

  /**
   * Creates or updates a privacy-safe chat notification alert for recipient
   * Does NOT store or expose confidential message content, only who sent it.
   */
  async createChatAlert(params: CreateChatAlertDto): Promise<NotificationAlert> {
    const { recipientId, senderId, senderName, senderRole, organizationName, conversationId } = params;

    // Avoid sending alert to oneself
    if (recipientId === senderId) {
      return null as any;
    }

    const description = `${senderName} has sent a message to you.`;
    const title = senderName;

    // Check if an unread alert already exists for this user and conversation
    const existing = await this.alertRepo.findOne({
      where: {
        user_id: recipientId,
        conversation_id: conversationId,
      },
    });

    if (existing) {
      existing.sender_id = senderId;
      existing.sender_name = senderName;
      existing.sender_role = senderRole;
      existing.organization_name = organizationName || existing.organization_name;
      existing.title = title;
      existing.description = description;
      existing.is_read = false;
      existing.updated_at = new Date();
      existing.created_at = new Date();
      return this.alertRepo.save(existing);
    }

    const alert = this.alertRepo.create({
      user_id: recipientId,
      conversation_id: conversationId,
      sender_id: senderId,
      sender_name: senderName,
      sender_role: senderRole,
      organization_name: organizationName || null,
      title,
      description,
      type: 'chat',
      is_read: false,
    });

    return this.alertRepo.save(alert);
  }

  /**
   * Retrieves active notification alerts for a given user
   */
  async getNotificationsForUser(userId: string): Promise<NotificationAlert[]> {
    return this.alertRepo.find({
      where: { user_id: userId },
      order: { updated_at: 'DESC', created_at: 'DESC' },
    });
  }

  /**
   * Deletes a specific notification alert to free table space
   */
  async deleteNotification(id: string, userId: string): Promise<{ affected: number }> {
    const result = await this.alertRepo.delete({ id, user_id: userId });
    return { affected: result.affected || 0 };
  }

  /**
   * Deletes notification alert(s) for a conversation when user opens that chat or marks it as read
   */
  async deleteByConversation(conversationId: string, userId: string): Promise<{ affected: number }> {
    const result = await this.alertRepo.delete({
      conversation_id: conversationId,
      user_id: userId,
    });
    return { affected: result.affected || 0 };
  }

  /**
   * Clears/deletes all notifications for the user to free space
   */
  async clearAllForUser(userId: string): Promise<{ affected: number }> {
    const result = await this.alertRepo.delete({ user_id: userId });
    return { affected: result.affected || 0 };
  }

  /**
   * When user clicks "Mark all read", delete all alerts from the table as requested
   */
  async markAllAsRead(userId: string): Promise<{ affected: number }> {
    return this.clearAllForUser(userId);
  }
}
