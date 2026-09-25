import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type CallType = 'audio' | 'video';
export type CallStatus =
  | 'initiated'
  | 'ringing'
  | 'ongoing'
  | 'completed'
  | 'rejected'
  | 'missed'
  | 'busy'
  | 'failed';

@Entity('call_sessions')
@Index(['caller_id', 'created_at'])
@Index(['receiver_id', 'created_at'])
@Index(['conversation_id'])
export class CallSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  caller_id: string;

  @Column({ type: 'varchar', length: 120 })
  caller_name: string;

  @Column({ type: 'varchar', length: 50, default: 'student' })
  caller_role: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  caller_avatar: string | null;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  receiver_id: string;

  @Column({ type: 'varchar', length: 120 })
  receiver_name: string;

  @Column({ type: 'varchar', length: 50, default: 'student' })
  receiver_role: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  receiver_avatar: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  conversation_id: string | null;

  @Column({
    type: 'enum',
    enum: ['audio', 'video'],
    default: 'audio',
  })
  call_type: CallType;

  @Column({
    type: 'enum',
    enum: [
      'initiated',
      'ringing',
      'ongoing',
      'completed',
      'rejected',
      'missed',
      'busy',
      'failed',
    ],
    default: 'initiated',
  })
  status: CallStatus;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  started_at: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  answered_at: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  ended_at: Date | null;

  @Column({ type: 'int', default: 0 })
  duration_seconds: number;

  @Column({ type: 'varchar', length: 60, nullable: true })
  end_reason: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updated_at: Date;
}
