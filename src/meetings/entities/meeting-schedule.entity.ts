import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export interface MeetingAttendeeItem {
  id: string;
  userId?: string;
  name: string;
  email?: string;
  role: string;
  organizationName?: string;
}

@Entity('Meeting_schedules')
@Index(['meeting_date'])
@Index(['organizer_id'])
export class MeetingSchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  meeting_subject: string;

  @Column({ type: 'varchar', length: 20 })
  meeting_date: string; // YYYY-MM-DD

  @Column({ type: 'varchar', length: 30 })
  start_time: string; // e.g. 09:30:00 AM

  @Column({ type: 'varchar', length: 30 })
  end_time: string; // e.g. 10:30:00 AM

  @Column({ type: 'varchar', length: 100 })
  organizer_id: string;

  @Column({ type: 'varchar', length: 150 })
  organizer_name: string;

  @Column({ type: 'varchar', length: 150, nullable: true })
  organizer_email: string | null;

  @Column({ type: 'varchar', length: 50, default: 'student' })
  organizer_role: string;

  @Column({ type: 'json' })
  attendees: MeetingAttendeeItem[];

  @Column({ type: 'json' })
  attendee_ids: string[];

  @Column({ type: 'varchar', length: 50, default: 'scheduled' })
  status: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updated_at: Date;
}
