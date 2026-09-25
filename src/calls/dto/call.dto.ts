export type CallMediaType = 'audio' | 'video';

export interface InitiateCallDto {
  targetUserId: string;
  targetUserName?: string;
  targetUserRole?: string;
  targetUserAvatar?: string;
  conversationId?: string;
  callType?: CallMediaType;
  offer: any; // RTCSessionDescriptionInit (SDP offer)
}

export interface AcceptCallDto {
  callId: string;
  targetUserId: string;
  answer: any; // RTCSessionDescriptionInit (SDP answer)
}

export interface RejectCallDto {
  callId: string;
  targetUserId: string;
  reason?: 'declined' | 'busy' | 'unavailable' | string;
}

export interface EndCallDto {
  callId: string;
  targetUserId?: string;
  reason?: 'caller_hangup' | 'receiver_hangup' | 'normal' | 'connection_lost' | string;
}

export interface IceCandidateDto {
  callId: string;
  targetUserId: string;
  candidate: any; // RTCIceCandidateInit
}

export interface ToggleMediaDto {
  callId: string;
  targetUserId: string;
  mediaType: 'audio' | 'video';
  isEnabled: boolean;
}

export interface CallHistoryQueryDto {
  conversationId?: string;
  limit?: number;
  offset?: number;
}
