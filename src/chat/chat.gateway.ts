import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ChatService, UserContext } from './chat.service';
import { SendMessageDto } from './dto/chat.dto';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle new WebSocket client connection
   */
  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      let user: UserContext;

      if (token) {
        const secret = this.configService.get<string>('JWT_SECRET', 'secretKey');
        const payload: any = this.jwtService.verify(token, { secret });
        user = {
          id: payload.sub || payload.id || payload.userId || client.id,
          name: payload.name || payload.firstName || payload.email || 'User',
          role: payload.role || 'student',
          organizationId: payload.organizationId || null,
        };
      } else {
        // Fallback for development / unauthenticated handshake
        const queryUser = client.handshake.query;
        user = {
          id: (queryUser.userId as string) || `guest-${client.id.slice(0, 5)}`,
          name: (queryUser.userName as string) || 'Guest User',
          role: (queryUser.userRole as string) || 'student',
          organizationId: (queryUser.organizationId as string) || null,
        };
      }

      client.data.user = user;

      // Track active sockets per user
      if (!this.userSockets.has(user.id)) {
        this.userSockets.set(user.id, new Set());
      }
      this.userSockets.get(user.id)!.add(client.id);
      client.join(`user_${user.id}`);

      this.logger.log(`Client connected: ${client.id} (User: ${user.name} [${user.role}])`);

      // Broadcast user online status
      this.server.emit('user_presence', {
        userId: user.id,
        status: 'online',
        timestamp: new Date().toISOString(),
      });

      // Mark pending sent messages as delivered
      this.chatService
        .markMessagesAsDeliveredForUser(user.id)
        .then((convIds) => {
          if (convIds && convIds.length > 0) {
            this.server.emit('messages_delivered', {
              userId: user.id,
              conversationIds: convIds,
            });
          }
        })
        .catch((e) => this.logger.warn(`Delivered update notice: ${e.message}`));
    } catch (err: any) {
      this.logger.warn(`Connection rejected for ${client.id}: ${err.message}`);
      client.disconnect();
    }
  }

  /**
   * Handle client disconnect
   */
  handleDisconnect(client: Socket) {
    const user: UserContext | undefined = client.data.user;
    if (user && this.userSockets.has(user.id)) {
      const set = this.userSockets.get(user.id)!;
      set.delete(client.id);
      if (set.size === 0) {
        this.userSockets.delete(user.id);
        this.server.emit('user_presence', {
          userId: user.id,
          status: 'offline',
          timestamp: new Date().toISOString(),
        });
      }
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Client joins conversation room
   */
  @SubscribeMessage('join_conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!data?.conversationId) return;
    const user: UserContext = client.data.user;
    if (!user) return { error: 'Unauthorized' };

    const canAccess = await this.chatService.canUserAccessConversation(data.conversationId, user);
    if (!canAccess) {
      this.logger.warn(`User ${user.id} denied access to conversation ${data.conversationId}`);
      return { error: 'Forbidden' };
    }

    const roomName = `conv_${data.conversationId}`;
    client.join(roomName);
    this.logger.log(`Socket ${client.id} joined room ${roomName}`);

    await this.chatService.markConversationAsRead(data.conversationId, user.id);
    this.server.to(roomName).emit('messages_read', {
      conversationId: data.conversationId,
      readerId: user.id,
    });

    return { status: 'joined', room: roomName };
  }

  /**
   * Client leaves conversation room
   */
  @SubscribeMessage('leave_conversation')
  handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (!data?.conversationId) return;
    const roomName = `conv_${data.conversationId}`;
    client.leave(roomName);
    return { status: 'left', room: roomName };
  }

  /**
   * Client sends message in conversation room
   */
  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendMessageDto,
  ) {
    const user: UserContext = client.data.user;
    if (!user) return { error: 'Unauthorized' };

    const canAccess = await this.chatService.canUserAccessConversation(dto.conversation_id, user);
    if (!canAccess) {
      this.logger.warn(`User ${user.id} denied sending message to conversation ${dto.conversation_id}`);
      return { error: 'Forbidden' };
    }

    try {
      const roomName = `conv_${dto.conversation_id}`;
      // Newly sent/forwarded messages always start as 'delivered'
      // They become 'read' ONLY when the receiver actively reads the conversation
      const initialStatus: 'sent' | 'delivered' | 'read' = 'delivered';

      const savedMessage = await this.chatService.saveMessage(dto, user, initialStatus);

      // Broadcast message to everyone in the conversation room and each participant's personal room
      const participantUserIds = await this.chatService.getParticipantUserIds(dto.conversation_id);
      const targetRooms = Array.from(new Set([roomName, ...participantUserIds.map((uid) => `user_${uid}`)]));
      this.server.to(targetRooms).emit('receive_message', savedMessage);

      return { status: 'sent', message: savedMessage };
    } catch (error: any) {
      this.logger.error(`Failed to send message: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Client marks conversation as read
   */
  @SubscribeMessage('mark_as_read')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data?.conversationId) return;

    try {
      await this.chatService.markConversationAsRead(data.conversationId, user.id);
      const roomName = `conv_${data.conversationId}`;
      this.server.to(roomName).emit('messages_read', {
        conversationId: data.conversationId,
        readerId: user.id,
      });
      return { status: 'success' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Client indicates typing status
   */
  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; isTyping: boolean },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data.conversationId) return;

    const roomName = `conv_${data.conversationId}`;
    client.to(roomName).emit('user_typing', {
      conversationId: data.conversationId,
      userId: user.id,
      userName: user.name,
      isTyping: data.isTyping,
    });
  }

  /**
   * Client reacts with emoji to message
   */
  @SubscribeMessage('react_message')
  async handleReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; messageId: string; emoji: string },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data.messageId || !data.emoji) return;

    try {
      const result = await this.chatService.toggleReaction(data.messageId, data.emoji);
      const roomName = `conv_${data.conversationId}`;

      this.server.to(roomName).emit('message_reacted', {
        conversationId: data.conversationId,
        messageId: data.messageId,
        reactions: result.reactions,
      });
      return { status: 'success' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Client edits message
   */
  @SubscribeMessage('edit_message')
  async handleEditMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; messageId: string; content: string },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data.messageId || !data.content) return;

    try {
      const result = await this.chatService.editMessage(data.messageId, data.content, user);
      const roomName = `conv_${data.conversationId}`;

      this.server.to(roomName).emit('message_edited', {
        conversationId: data.conversationId,
        messageId: data.messageId,
        content: result.content,
        isEdited: true,
        editedAt: result.editedAt,
      });
      return { status: 'success' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Client deletes message
   */
  @SubscribeMessage('delete_message')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; messageId: string },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data.messageId) return;

    try {
      await this.chatService.deleteMessage(data.messageId, user);
      const roomName = `conv_${data.conversationId}`;

      this.server.to(roomName).emit('message_deleted', {
        conversationId: data.conversationId,
        messageId: data.messageId,
      });
      return { status: 'success' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Client pins or unpins message
   */
  @SubscribeMessage('pin_message')
  async handlePinMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; messageId: string },
  ) {
    if (!data.messageId) return;

    try {
      const result = await this.chatService.togglePinMessage(data.messageId);
      const roomName = `conv_${data.conversationId}`;

      this.server.to(roomName).emit('message_pinned', {
        conversationId: data.conversationId,
        messageId: data.messageId,
        isPinned: result.isPinned,
      });
      return { status: 'success', isPinned: result.isPinned };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private extractToken(client: Socket): string | null {
    const authHeader =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization ||
      client.handshake.query?.token;

    if (typeof authHeader === 'string') {
      if (authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
      }
      return authHeader;
    }
    return null;
  }
}
