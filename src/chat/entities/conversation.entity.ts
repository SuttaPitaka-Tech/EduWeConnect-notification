import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { Participant } from './participant.entity';
import { Message } from './message.entity';

export type ConversationType = 'direct' | 'channel';

@Entity('chat_conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ['direct', 'channel'],
    default: 'direct',
  })
  type: ConversationType;

  @Column({ type: 'varchar', length: 120, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  topic: string | null;

  @Column({ type: 'boolean', default: false })
  is_private: boolean;

  @Column({ type: 'varchar', length: 100 })
  created_by: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  organization_id: string | null;

  @Index()
  @Column({ type: 'datetime', nullable: true })
  last_message_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => Participant, (p: Participant) => p.conversation, { cascade: true })
  participants: Participant[];

  @OneToMany(() => Message, (m: Message) => m.conversation)
  messages: Message[];
}
