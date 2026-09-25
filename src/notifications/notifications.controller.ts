import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

interface UserContext {
  id: string;
  name: string;
  role: string;
  organizationId?: string | null;
}

@Controller(['api/notifications', 'notifications'])
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Helper to extract user context from request (JWT payload or fallback headers)
   */
  private getUserContext(req: Request): UserContext {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded: any = this.jwtService.decode(token);
        if (decoded) {
          return {
            id: decoded.sub || decoded.id || decoded.userId || decoded.email || 'current-user',
            name: decoded.name || decoded.firstName || decoded.email?.split('@')[0] || 'User',
            role: decoded.role || 'student',
            organizationId: decoded.organizationId || decoded.institutionId || null,
          };
        }
      } catch (e) {}
    }

    const user = req['user'];
    if (user) {
      return {
        id: user.sub || user.id || user.userId,
        name: user.name || user.firstName || user.email || 'User',
        role: user.role || 'student',
        organizationId: user.organizationId || user.institutionId || null,
      };
    }

    const userId = (req.headers['x-user-id'] as string) || 'current-user';
    const userName = (req.headers['x-user-name'] as string) || 'Edu User';
    const userRole = (req.headers['x-user-role'] as string) || 'student';
    const orgId = (req.headers['x-org-id'] as string) || (req.headers['x-institution-id'] as string);

    return {
      id: userId,
      name: userName,
      role: userRole,
      organizationId: orgId || null,
    };
  }

  /**
   * Format friendly relative timestamp & date for notification cards
   */
  private formatNotificationTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHrs = Math.floor(diffMin / 60);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin} min ago`;

    // Check if same day
    const isToday =
      now.getDate() === date.getDate() &&
      now.getMonth() === date.getMonth() &&
      now.getFullYear() === date.getFullYear();

    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isToday) {
      return `Today at ${timeStr}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      yesterday.getDate() === date.getDate() &&
      yesterday.getMonth() === date.getMonth() &&
      yesterday.getFullYear() === date.getFullYear();

    if (isYesterday) {
      return `Yesterday at ${timeStr}`;
    }

    const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return `${dateStr}, ${timeStr}`;
  }

  /**
   * Get all active notifications for the current user
   */
  @Get()
  async getMyNotifications(@Req() req: Request) {
    const user = this.getUserContext(req);
    const alerts = await this.notificationsService.getNotificationsForUser(user.id);

    return alerts.map((a) => {
      const displayDate = a.updated_at || a.created_at;
      const formattedRole = a.sender_role
        ? a.sender_role.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : undefined;

      return {
        id: a.id,
        conversationId: a.conversation_id,
        senderId: a.sender_id,
        senderName: a.sender_name,
        senderRole: a.sender_role,
        organizationName: a.organization_name || a.sender_name,
        title: a.title,
        description: a.description,
        timestamp: this.formatNotificationTime(displayDate),
        createdAt: displayDate.toISOString(),
        isRead: a.is_read,
        type: 'chat',
        tag: formattedRole,
      };
    });
  }

  /**
   * Mark all notifications as read / delete them to free table space
   */
  @Post('mark-all-read')
  async markAllRead(@Req() req: Request) {
    const user = this.getUserContext(req);
    return this.notificationsService.markAllAsRead(user.id);
  }

  /**
   * Clear all notifications for user
   */
  @Delete('clear-all')
  async clearAllNotifications(@Req() req: Request) {
    const user = this.getUserContext(req);
    return this.notificationsService.clearAllForUser(user.id);
  }

  /**
   * Delete notifications for a specific conversation (e.g. when opened/viewed in chat)
   */
  @Delete('conversation/:conversationId')
  async deleteByConversation(
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    const user = this.getUserContext(req);
    return this.notificationsService.deleteByConversation(conversationId, user.id);
  }

  /**
   * Delete a specific notification by ID
   */
  @Delete(':id')
  async deleteNotification(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = this.getUserContext(req);
    return this.notificationsService.deleteNotification(id, user.id);
  }
}
