import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MeetingsService, UserContext } from './meetings.service';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import type { Request } from 'express';

@Controller(['api/meetings', 'meetings'])
export class MeetingsController {
  constructor(
    private readonly meetingsService: MeetingsService,
    private readonly jwtService: JwtService,
  ) {}

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
            email: decoded.email || null,
            organizationId: decoded.organizationId || decoded.institutionId || null,
          };
        }
      } catch (e) {}
    }

    const user = req['user'];
    if (user) {
      return {
        id: user.sub || user.id || user.userId || 'current-user',
        name: user.name || user.firstName || user.email || 'User',
        role: user.role || 'student',
        email: user.email || null,
        organizationId: user.organizationId || user.institutionId || null,
      };
    }

    const userId = (req.headers['x-user-id'] as string) || 'current-user';
    const userName = (req.headers['x-user-name'] as string) || 'User';
    const userRole = (req.headers['x-user-role'] as string) || 'student';
    const userEmail = (req.headers['x-user-email'] as string) || undefined;

    return {
      id: userId,
      name: userName,
      role: userRole,
      email: userEmail,
      organizationId: null,
    };
  }

  @Post()
  async createMeeting(@Body() dto: CreateMeetingDto, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.meetingsService.createMeeting(dto, user);
  }

  @Get()
  async getMyMeetings(@Req() req: Request) {
    const user = this.getUserContext(req);
    return this.meetingsService.getMyMeetings(user);
  }

  @Delete(':id')
  async deleteMeeting(@Param('id') id: string, @Req() req: Request) {
    const user = this.getUserContext(req);
    return this.meetingsService.deleteMeeting(id, user);
  }
}
