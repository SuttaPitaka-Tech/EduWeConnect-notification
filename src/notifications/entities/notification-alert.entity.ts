import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('notification_alert')
@Index(['user_id'])
@Index(['user_id', 'conversation_id'])
export class NotificationAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Recipient user ID who receives this notification */
  @Column({ type: 'varchar', length: 128 })
  user_id: string;

  /** Linked conversation ID */
  @Column({ type: 'varchar', length: 128 })
  conversation_id: string;

  /** Sender user ID */
  @Column({ type: 'varchar', length: 128 })
  sender_id: string;

  /** Sender display name */
  @Column({ type: 'varchar', length: 255 })
  sender_name: string;

  /** Sender role (e.g., student, staff, organization, super_admin) */
  @Column({ type: 'varchar', length: 64 })
  sender_role: string;

  /** Sender institution/organization name if applicable */
  @Column({ type: 'varchar', length: 255, nullable: true })
  organization_name: string | null;

  /** Title displayed in the notification card */
  @Column({ type: 'varchar', length: 255 })
  title: string;

  /** Privacy-preserving description (never reveals the confidential message body) */
  @Column({ type: 'text' })
  description: string;

  /** Notification category */
  @Column({ type: 'varchar', length: 64, default: 'chat' })
  type: string;

  /** Read state */
  @Column({ type: 'boolean', default: false })
  is_read: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
