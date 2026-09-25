import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { CallsService } from './calls.service';
import { JwtService } from '@nestjs/jwt';
import { UserContext } from '../chat/chat.service';
import type { Request } from 'express';

@Controller(['api/calls', 'calls'])
export class CallsController {
  constructor(
    private readonly callsService: CallsService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Helper to extract user context from request
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

    return {
      id: (req.headers['x-user-id'] as string) || 'current-user',
      name: (req.headers['x-user-name'] as string) || 'Edu User',
      role: (req.headers['x-user-role'] as string) || 'student',
      organizationId: (req.headers['x-organization-id'] as string) || null,
    };
  }

  /**
   * Returns WebRTC ICE (STUN/TURN) servers for client peer connection setup
   */
  @Get('ice-servers')
  getIceServers() {
    return {
      iceServers: this.callsService.getIceServers(),
    };
  }

  /**
   * Returns call logs / history for the current user
   */
  @Get('history')
  async getCallHistory(
    @Req() req: Request,
    @Query('conversationId') conversationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const user = this.getUserContext(req);
    return this.callsService.getCallHistory(user.id, {
      conversationId,
      limit: limit ? parseInt(limit, 10) : 30,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  /**
   * Get active call status for current user if one is currently active
   */
  @Get('active')
  async getActiveCall(@Req() req: Request) {
    const user = this.getUserContext(req);
    const activeCallId = this.callsService.getActiveCallIdForUser(user.id);
    if (!activeCallId) {
      return { active: false, call: null };
    }
    const session = this.callsService.getActiveCall(activeCallId);
    return { active: true, call: session };
  }

  /**
   * Get call session by ID
   */
  @Get(':id')
  async getCallById(@Param('id') id: string) {
    return this.callsService.getCallById(id);
  }
}
