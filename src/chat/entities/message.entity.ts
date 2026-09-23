import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { Attachment } from './attachment.entity';

export type MessageType = 'text' | 'file' | 'system';

@Entity('chat_messages')
@Index(['conversation_id', 'created_at'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  conversation_id: string;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  sender_id: string;

  @Column({ type: 'varchar', length: 120 })
  sender_name: string;

  @Column({ type: 'varchar', length: 50 })
  sender_role: string;

  @Column({ type: 'text' })
  content: string;

  @Column({
    type: 'enum',
    enum: ['text', 'file', 'system'],
    default: 'text',
  })
  message_type: MessageType;

  @Column({ type: 'varchar', length: 36, nullable: true })
  reply_to_id: string | null;

  @Column({ type: 'boolean', default: false })
  is_deleted: boolean;

  @Column({ type: 'boolean', default: false })
  is_pinned: boolean;

  @Column({ type: 'boolean', default: false })
  is_edited: boolean;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  edited_at: Date | null;

  @Column({ type: 'simple-json', nullable: true })
  reactions: Record<string, number> | null;

  @Column({
    type: 'enum',
    enum: ['sent', 'delivered', 'read'],
    default: 'sent',
  })
  status: 'sent' | 'delivered' | 'read';

  @Column({ type: 'datetime', precision: 6, nullable: true })
  delivered_at: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  read_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @OneToMany(() => Attachment, (a) => a.message, { cascade: true })
  attachments: Attachment[];
}
