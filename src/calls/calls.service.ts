import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CallSession, CallStatus } from './entities/call-session.entity';
import {
  InitiateCallDto,
  AcceptCallDto,
  RejectCallDto,
  EndCallDto,
  CallHistoryQueryDto,
} from './dto/call.dto';
import { UserContext } from '../chat/chat.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface ActiveCallContext {
  callId: string;
  callerId: string;
  callerName: string;
  callerRole: string;
  receiverId: string;
  receiverName: string;
  receiverRole: string;
  conversationId: string | null;
  callType: 'audio' | 'video';
  status: CallStatus;
  startedAt: Date;
  answeredAt: Date | null;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  // In-memory cache for ultra-fast call lookup during active signaling
  private readonly activeCalls = new Map<string, ActiveCallContext>();
  private readonly userCallMap = new Map<string, string>(); // userId -> callId
  private readonly ringTimeouts = new Map<string, NodeJS.Timeout>();

  // Ring timeout in milliseconds before marking as missed
  private readonly RING_TIMEOUT_MS = 35000;

  constructor(
    @InjectRepository(CallSession)
    private readonly callRepo: Repository<CallSession>,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Check if a user is currently engaged in an active call
   */
  isUserInCall(userId: string): boolean {
    return this.userCallMap.has(userId);
  }

  /**
   * Get the active call ID for a user
   */
  getActiveCallIdForUser(userId: string): string | undefined {
    return this.userCallMap.get(userId);
  }

  /**
   * Retrieve active call session context
   */
  getActiveCall(callId: string): ActiveCallContext | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Start a new call session
   */
  async initiateCall(
    caller: UserContext,
    dto: InitiateCallDto,
    onTimeout: (callId: string, callerId: string, receiverId: string) => void,
  ): Promise<CallSession> {
    const { targetUserId, targetUserName, targetUserRole, targetUserAvatar, conversationId, callType } =
      dto;

    if (caller.id === targetUserId) {
      throw new BadRequestException('Cannot initiate a call to yourself');
    }

    // Create CallSession record in database
    const callSession = this.callRepo.create({
      caller_id: caller.id,
      caller_name: caller.name,
      caller_role: caller.role || 'student',
      caller_avatar: null,
      receiver_id: targetUserId,
      receiver_name: targetUserName || 'User',
      receiver_role: targetUserRole || 'student',
      receiver_avatar: targetUserAvatar || null,
      conversation_id: conversationId || null,
      call_type: callType || 'audio',
      status: 'ringing',
      started_at: new Date(),
    });

    const saved = await this.callRepo.save(callSession);

    // Save in-memory context
    const activeContext: ActiveCallContext = {
      callId: saved.id,
      callerId: caller.id,
      callerName: caller.name,
      callerRole: caller.role || 'student',
      receiverId: targetUserId,
      receiverName: targetUserName || 'User',
      receiverRole: targetUserRole || 'student',
      conversationId: conversationId || null,
      callType: callType || 'audio',
      status: 'ringing',
      startedAt: saved.started_at || new Date(),
      answeredAt: null,
    };

    this.activeCalls.set(saved.id, activeContext);
    this.userCallMap.set(caller.id, saved.id);
    this.userCallMap.set(targetUserId, saved.id);

    // Setup ring timeout (35 seconds)
    const timer = setTimeout(async () => {
      await this.handleMissedCall(saved.id);
      onTimeout(saved.id, caller.id, targetUserId);
    }, this.RING_TIMEOUT_MS);

    this.ringTimeouts.set(saved.id, timer);
    this.logger.log(`Call initiated [${saved.id}]: ${caller.name} -> ${targetUserName || targetUserId}`);

    return saved;
  }

  /**
   * Accept an incoming call
   */
  async acceptCall(receiver: UserContext, dto: AcceptCallDto): Promise<CallSession> {
    const { callId } = dto;
    this.clearRingTimeout(callId);

    const call = await this.callRepo.findOne({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException(`Call session ${callId} not found`);
    }

    const answeredAt = new Date();
    call.status = 'ongoing';
    call.answered_at = answeredAt;

    const saved = await this.callRepo.save(call);

    // Update in-memory session
    const active = this.activeCalls.get(callId);
    if (active) {
      active.status = 'ongoing';
      active.answeredAt = answeredAt;
    }

    this.logger.log(`Call accepted [${callId}] by ${receiver.name}`);
    return saved;
  }

  /**
   * Reject an incoming call
   */
  async rejectCall(user: UserContext, dto: RejectCallDto): Promise<CallSession> {
    const { callId, reason } = dto;
    this.clearRingTimeout(callId);

    const call = await this.callRepo.findOne({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException(`Call session ${callId} not found`);
    }

    call.status = 'rejected';
    call.ended_at = new Date();
    call.end_reason = reason || 'declined';

    const saved = await this.callRepo.save(call);
    this.cleanupActiveCall(callId);

    this.logger.log(`Call rejected [${callId}] by ${user.name}: ${call.end_reason}`);
    return saved;
  }

  /**
   * End / Hangup an ongoing or ringing call
   */
  async endCall(user: UserContext, dto: EndCallDto): Promise<{ call: CallSession | null; duration: number }> {
    let callId = dto.callId;
    if (!callId) {
      callId = this.userCallMap.get(user.id) || '';
    }

    if (callId) {
      this.clearRingTimeout(callId);
    }

    const call = callId ? await this.callRepo.findOne({ where: { id: callId } }) : null;
    if (!call) {
      // If not in database, still clean up memory gracefully
      if (callId) {
        this.cleanupActiveCall(callId);
      } else {
        this.userCallMap.delete(user.id);
      }
      return { call: null, duration: 0 };
    }

    const endedAt = new Date();
    call.ended_at = endedAt;
    call.end_reason = dto.reason || (call.answered_at ? 'normal' : 'cancelled_before_answer');

    let durationSeconds = 0;
    if (call.answered_at) {
      durationSeconds = Math.max(
        0,
        Math.floor((endedAt.getTime() - new Date(call.answered_at).getTime()) / 1000),
      );
      call.status = 'completed';
    } else {
      call.status = 'missed';
    }

    call.duration_seconds = durationSeconds;
    const saved = await this.callRepo.save(call);
    this.cleanupActiveCall(call.id);

    this.logger.log(
      `Call ended [${call.id}] by ${user.name}. Duration: ${durationSeconds}s. Status: ${saved.status}`,
    );

    return { call: saved, duration: durationSeconds };
  }

  /**
   * Handle missed call upon ring timeout
   */
  async handleMissedCall(callId: string): Promise<CallSession | null> {
    this.clearRingTimeout(callId);
    const call = await this.callRepo.findOne({ where: { id: callId } });
    if (!call || call.status !== 'ringing') {
      return null;
    }

    call.status = 'missed';
    call.ended_at = new Date();
    call.end_reason = 'missed_timeout';

    const saved = await this.callRepo.save(call);
    this.cleanupActiveCall(callId);

    // Create a missed call notification for the receiver
    try {
      if (call.conversation_id) {
        await this.notificationsService.createChatAlert({
          recipientId: call.receiver_id,
          senderId: call.caller_id,
          senderName: call.caller_name,
          senderRole: call.caller_role,
          conversationId: call.conversation_id,
        });
      }
    } catch (e: any) {
      this.logger.warn(`Failed to create missed call notification alert: ${e.message}`);
    }

    this.logger.log(`Call missed [${callId}] due to ring timeout`);
    return saved;
  }

  /**
   * Handle unexpected user disconnection during call
   */
  async handleUserDisconnect(userId: string): Promise<ActiveCallContext | null> {
    const callId = this.userCallMap.get(userId);
    if (!callId) return null;

    const active = this.activeCalls.get(callId);
    if (!active) {
      this.userCallMap.delete(userId);
      return null;
    }

    await this.endCall(
      { id: userId, name: 'System', role: 'system' },
      { callId, reason: 'connection_lost' },
    ).catch(() => {});

    return active;
  }

  /**
   * Fetch call history for a user
   */
  async getCallHistory(userId: string, query: CallHistoryQueryDto): Promise<{ calls: CallSession[]; total: number }> {
    const qb = this.callRepo
      .createQueryBuilder('call')
      .where('(call.caller_id = :userId OR call.receiver_id = :userId)', { userId })
      .orderBy('call.created_at', 'DESC');

    if (query.conversationId) {
      qb.andWhere('call.conversation_id = :convId', { convId: query.conversationId });
    }

    const limit = Math.min(query.limit || 30, 100);
    const offset = query.offset || 0;

    qb.skip(offset).take(limit);

    const [calls, total] = await qb.getManyAndCount();
    return { calls, total };
  }

  /**
   * Get single call session by ID
   */
  async getCallById(callId: string): Promise<CallSession> {
    const call = await this.callRepo.findOne({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException(`Call session ${callId} not found`);
    }
    return call;
  }

  /**
   * Returns standard, high-reliability ICE (STUN/TURN) servers for WebRTC peer connection
   */
  getIceServers(): RTCIceServer[] {
    const servers: RTCIceServer[] = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
          'stun:stun3.l.google.com:19302',
          'stun:stun4.l.google.com:19302',
        ],
      },
    ];

    // Optional TURN server credentials from environment
    const turnUrl = this.configService.get<string>('WEBRTC_TURN_URL');
    const turnUsername = this.configService.get<string>('WEBRTC_TURN_USERNAME');
    const turnCredential = this.configService.get<string>('WEBRTC_TURN_CREDENTIAL');

    if (turnUrl) {
      servers.push({
        urls: turnUrl,
        username: turnUsername,
        credential: turnCredential,
      });
    }

    return servers;
  }

  /**
   * Clean up in-memory records
   */
  private cleanupActiveCall(callId: string) {
    const active = this.activeCalls.get(callId);
    if (active) {
      this.userCallMap.delete(active.callerId);
      this.userCallMap.delete(active.receiverId);
      this.activeCalls.delete(callId);
    }
    this.clearRingTimeout(callId);
  }

  /**
   * Clear ring timeout timer
   */
  private clearRingTimeout(callId: string) {
    const timer = this.ringTimeouts.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.ringTimeouts.delete(callId);
    }
  }
}
