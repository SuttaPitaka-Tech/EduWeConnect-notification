import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MeetingSchedule } from './entities/meeting-schedule.entity';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { randomUUID } from 'crypto';

export interface UserContext {
  id: string;
  name: string;
  role: string;
  email?: string;
  organizationId?: string | null;
}

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    @InjectRepository(MeetingSchedule)
    private readonly meetingRepository: Repository<MeetingSchedule>,
  ) {}

  /**
   * Schedule a new meeting
   */
  async createMeeting(dto: CreateMeetingDto, user: UserContext): Promise<MeetingSchedule> {
    if (!dto.meeting_subject || !dto.meeting_subject.trim()) {
      throw new BadRequestException('Meeting subject is required');
    }
    if (!dto.meeting_date) {
      throw new BadRequestException('Meeting date is required');
    }
    if (!dto.start_time || !dto.end_time) {
      throw new BadRequestException('Start time and End time are required');
    }

    const attendees = dto.attendees || [];
    const attendeeIds = attendees
      .map((a) => a.userId || a.id)
      .filter((id): id is string => Boolean(id));

    const meeting = this.meetingRepository.create({
      id: randomUUID(),
      meeting_subject: dto.meeting_subject.trim(),
      meeting_date: dto.meeting_date,
      start_time: dto.start_time,
      end_time: dto.end_time,
      organizer_id: dto.organizer_id || user.id,
      organizer_name: dto.organizer_name || user.name || 'User',
      organizer_email: dto.organizer_email || user.email || null,
      organizer_role: dto.organizer_role || user.role || 'student',
      attendees: attendees,
      attendee_ids: attendeeIds,
      status: 'scheduled',
    });

    const saved = await this.meetingRepository.save(meeting);
    this.logger.log(
      `[Meetings] Scheduled meeting "${saved.meeting_subject}" (id: ${saved.id}) on ${saved.meeting_date} with ${attendees.length} attendees by ${saved.organizer_name}`,
    );

    return saved;
  }

  /**
   * Fetch all meetings where the user is either the organizer OR an attendee
   */
  async getMyMeetings(user: UserContext): Promise<MeetingSchedule[]> {
    const userId = user.id;
    const userEmail = user.email || '';

    // Fetch all meetings and filter in-memory/via query so JSON-encoded attendee IDs match accurately
    const allMeetings = await this.meetingRepository.find({
      order: {
        meeting_date: 'ASC',
        start_time: 'ASC',
      },
    });

    const userMeetings = allMeetings.filter((m) => {
      // 1. Is organizer
      if (m.organizer_id === userId) return true;
      if (userEmail && m.organizer_email === userEmail) return true;

      // 2. Is in attendee_ids
      if (Array.isArray(m.attendee_ids) && m.attendee_ids.includes(userId)) {
        return true;
      }

      // 3. Is in attendees array by ID or Email
      if (Array.isArray(m.attendees)) {
        const found = m.attendees.some(
          (a) =>
            a.id === userId ||
            a.userId === userId ||
            (userEmail && a.email && a.email.toLowerCase() === userEmail.toLowerCase()),
        );
        if (found) return true;
      }

      return false;
    });

    return userMeetings;
  }

  /**
   * Delete / Cancel meeting
   */
  async deleteMeeting(id: string, user: UserContext): Promise<{ success: boolean }> {
    const meeting = await this.meetingRepository.findOne({ where: { id } });
    if (!meeting) {
      throw new BadRequestException('Meeting not found');
    }
    // Only organizer can delete/cancel
    if (meeting.organizer_id !== user.id && user.role !== 'super_admin') {
      throw new BadRequestException('Only the meeting organizer can cancel this meeting');
    }
    await this.meetingRepository.delete(id);
    return { success: true };
  }
}
