import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ChatService, UserContext } from './chat.service';
import { JwtService } from '@nestjs/jwt';
import { CreateGroupDto, DirectChatDto, SendMessageDto } from './dto/chat.dto';
import type { Request } from 'express';

@Controller(['api/chat', 'chat'])
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
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

    // Fallback headers for internal microservice calls
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
   * Get all conversations for current user
   */
  @Get('conversations')
  async getConversations(@Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.getUserConversations(user.id, user.organizationId);
  }

  /**
   * Get real users / contacts directory from database for 1-on-1 chat & group selection
   */
  @Get('contacts')
  async getContacts(@Req() req: Request, @Query('q') query?: string) {
    const user = this.getUserContext(req);
    return this.chatService.getChatContacts(user, query);
  }

  /**
   * Get paginated messages for a conversation
   */
  @Get('conversations/:id/messages')
  async getMessages(
    @Req() req: Request,
    @Param('id') conversationId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    const user = this.getUserContext(req);
    return this.chatService.getConversationMessages(
      conversationId,
      user,
      parseInt(page, 10) || 1,
      parseInt(limit, 10) || 50,
    );
  }

  /**
   * Create a new Group / Channel
   */
  @Post('groups')
  async createGroup(@Body() dto: CreateGroupDto, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.createGroup(dto, user);
  }

  /**
   * Start or retrieve 1-on-1 Direct Chat
   */
  @Post('direct')
  async getOrCreateDirectChat(@Body() dto: DirectChatDto, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.getOrCreateDirectChat(user, dto);
  }

  /**
   * Mark messages in conversation as read
   */
  @Post('conversations/:id/read')
  async markAsRead(@Param('id') conversationId: string, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.markConversationAsRead(conversationId, user.id);
  }

  /**
   * Send message (REST fallback)
   */
  @Post('messages')
  async sendMessage(@Body() dto: SendMessageDto, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.saveMessage(dto, user);
  }

  /**
   * Upload image/document/file to MinIO under chat-files/
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max limit
    }),
  )
  async uploadAttachment(
    @UploadedFile() file: Express.Multer.File,
    @Query('conversationId') conversationId: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided for upload');
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new BadRequestException('File size exceeds the maximum limit of 2MB');
    }
    const convId = conversationId || 'general';
    return this.chatService.uploadAttachmentToMinio(file, convId);
  }

  /**
   * Edit message
   */
  @Patch('messages/:id')
  async editMessage(
    @Param('id') messageId: string,
    @Body('content') content: string,
    @Req() req: Request,
  ) {
    if (!content || !content.trim()) {
      throw new BadRequestException('Content is required');
    }
    const user = this.getUserContext(req);
    return this.chatService.editMessage(messageId, content, user);
  }

  /**
   * Delete message
   */
  @Delete('messages/:id')
  async deleteMessage(@Param('id') messageId: string, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.deleteMessage(messageId, user);
  }

  /**
   * Toggle pin message
   */
  @Post('messages/:id/pin')
  async togglePin(@Param('id') messageId: string) {
    return this.chatService.togglePinMessage(messageId);
  }

  /**
   * Clear chat history for current user only
   */
  @Post('conversations/:id/clear')
  async clearChatHistory(@Param('id') conversationId: string, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.clearChatHistory(conversationId, user);
  }

  /**
   * Hide conversation for current user
   */
  @Post('conversations/:id/hide')
  async hideChat(@Param('id') conversationId: string, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.chatService.hideChat(conversationId, user);
  }
}
