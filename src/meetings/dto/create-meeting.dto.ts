import { MeetingAttendeeItem } from '../entities/meeting-schedule.entity';

export class CreateMeetingDto {
  meeting_subject: string;
  meeting_date: string; // YYYY-MM-DD
  start_time: string; // e.g. 09:30:00 AM
  end_time: string; // e.g. 10:30:00 AM
  attendees: MeetingAttendeeItem[];
  organizer_id?: string;
  organizer_name?: string;
  organizer_email?: string;
  organizer_role?: string;
  description?: string;
}
