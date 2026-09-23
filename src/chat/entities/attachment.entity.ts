import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Message } from './message.entity';

@Entity('chat_attachments')
export class Attachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  message_id: string;

  @Column({ type: 'varchar', length: 255 })
  file_name: string;

  @Column({ type: 'varchar', length: 80 })
  file_type: string;

  @Column({ type: 'varchar', length: 30 })
  file_size: string;

  @Column({ type: 'varchar', length: 500 })
  storage_key: string;

  @Column({ type: 'text', nullable: true })
  url: string | null;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Message, (m: Message) => m.attachments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message: Message;
}
