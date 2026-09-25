import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Conversation } from './conversation.entity';

@Entity('chat_participants')
@Unique(['conversation_id', 'user_id'])
export class Participant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  conversation_id: string;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  user_id: string;

  @Column({ type: 'varchar', length: 50 })
  user_role: string;

  @Column({ type: 'varchar', length: 120 })
  user_name: string;

  @Column({ type: 'boolean', default: false })
  is_admin: boolean;

  @Column({ type: 'varchar', length: 36, nullable: true })
  last_read_message_id: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  cleared_at: Date | null;

  @Column({ type: 'boolean', default: false })
  is_hidden: boolean;

  @CreateDateColumn()
  joined_at: Date;

  @ManyToOne(() => Conversation, (c) => c.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;
}
