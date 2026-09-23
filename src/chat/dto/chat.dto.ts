export class CreateGroupDto {
  name: string;
  topic?: string;
  is_private?: boolean;
  member_ids?: string[];
  initial_message?: string;
  organization_id?: string;
}

export class DirectChatDto {
  recipient_id: string;
  recipient_role: string;
  recipient_name: string;
}

export class SendMessageDto {
  conversation_id: string;
  content: string;
  message_type?: 'text' | 'file' | 'system';
  reply_to_id?: string;
  attachments?: {
    file_name: string;
    file_type: string;
    file_size: string;
    storage_key: string;
    url?: string;
  }[];
}

export class AddMembersDto {
  member_ids: string[];
}
