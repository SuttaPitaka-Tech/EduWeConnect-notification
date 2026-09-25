import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CallsService } from './calls.service';
import {
  InitiateCallDto,
  AcceptCallDto,
  RejectCallDto,
  EndCallDto,
  IceCandidateDto,
} from './dto/call.dto';
import { UserContext } from '../chat/chat.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class CallsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(CallsGateway.name);
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly callsService: CallsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle incoming WebSocket connection for WebRTC signaling
   */
  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      let user: UserContext;

      if (token) {
        try {
          const secret = this.configService.get<string>('JWT_SECRET', 'secretKey');
          const payload: any = this.jwtService.verify(token, { secret });
          user = {
            id: payload.sub || payload.id || payload.userId || client.id,
            name: payload.name || payload.firstName || payload.email || 'User',
            role: payload.role || 'student',
            organizationId: payload.organizationId || null,
          };
        } catch {
          const decoded: any = this.jwtService.decode(token);
          if (decoded) {
            user = {
              id: decoded.sub || decoded.id || decoded.userId || client.id,
              name: decoded.name || decoded.firstName || decoded.email || 'User',
              role: decoded.role || 'student',
              organizationId: decoded.organizationId || null,
            };
          } else {
            const query = client.handshake.query;
            user = {
              id: (query.userId as string) || `guest-${client.id.slice(0, 5)}`,
              name: (query.userName as string) || 'Guest User',
              role: (query.userRole as string) || 'student',
              organizationId: (query.organizationId as string) || null,
            };
          }
        }
      } else {
        const query = client.handshake.query;
        user = {
          id: (query.userId as string) || `guest-${client.id.slice(0, 5)}`,
          name: (query.userName as string) || 'Guest User',
          role: (query.userRole as string) || 'student',
          organizationId: (query.organizationId as string) || null,
        };
      }

      client.data.user = user;

      // Track active sockets
      if (!this.userSockets.has(user.id)) {
        this.userSockets.set(user.id, new Set());
      }
      this.userSockets.get(user.id)!.add(client.id);

      // Join personal room for 1-to-1 signaling
      client.join(`user_${user.id}`);
      this.logger.log(`CallsGateway: Client connected ${client.id} (User: ${user.name} [${user.id}])`);
    } catch (err: any) {
      this.logger.warn(`CallsGateway: Connection auth failed for ${client.id}: ${err.message}`);
    }
  }

  /**
   * Handle WebSocket disconnect
   */
  async handleDisconnect(client: Socket) {
    const user: UserContext | undefined = client.data.user;
    if (user && this.userSockets.has(user.id)) {
      const socketSet = this.userSockets.get(user.id)!;
      socketSet.delete(client.id);
      if (socketSet.size === 0) {
        this.userSockets.delete(user.id);
      }

      // If user disconnects while an active call was ongoing, clean up and inform peer
      const activeCall = await this.callsService.handleUserDisconnect(user.id);
      if (activeCall) {
        const peerId = activeCall.callerId === user.id ? activeCall.receiverId : activeCall.callerId;
        this.server.to(`user_${peerId}`).emit('call_ended', {
          callId: activeCall.callId,
          reason: 'connection_lost',
          endedBy: user.id,
          duration: 0,
        });
        this.logger.log(`Active call ${activeCall.callId} terminated due to disconnect of user ${user.id}`);
      }
    }
  }

  /**
   * INITIATE CALL
   * Caller sends SDP Offer to recipient
   */
  @SubscribeMessage('call_initiate')
  @SubscribeMessage('call:initiate')
  async handleInitiateCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: InitiateCallDto,
  ) {
    const caller: UserContext = client.data.user;
    if (!caller) return { error: 'Unauthorized' };

    if (!dto?.targetUserId) {
      return { error: 'Target user ID is required' };
    }

    // 1. Check if recipient is already in a call
    if (this.callsService.isUserInCall(dto.targetUserId)) {
      client.emit('call_busy', {
        targetUserId: dto.targetUserId,
        message: 'User is currently on another call',
      });
      return { status: 'busy', message: 'User is on another call' };
    }

    try {
      // 2. Initiate call in service (creates DB record, sets 35s ring timeout)
      const callSession = await this.callsService.initiateCall(
        caller,
        dto,
        (callId, callerId, receiverId) => {
          // Timeout callback if call is missed
          this.server.to(`user_${callerId}`).emit('call_no_answer', {
            callId,
            message: 'No answer from user',
          });
          this.server.to(`user_${receiverId}`).emit('call_missed', {
            callId,
            callerId,
            callerName: caller.name,
            timestamp: new Date().toISOString(),
          });
        },
      );

      // 3. Emit incoming call event to recipient's personal room
      this.server.to(`user_${dto.targetUserId}`).emit('call_incoming', {
        callId: callSession.id,
        callerId: caller.id,
        callerName: caller.name,
        callerRole: caller.role,
        callerAvatar: dto.targetUserAvatar || null,
        conversationId: dto.conversationId || null,
        callType: dto.callType || 'audio',
        offer: dto.offer,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Emitted call_incoming to user_${dto.targetUserId} for call ${callSession.id}`);

      return {
        status: 'ringing',
        callId: callSession.id,
        callerId: caller.id,
        targetUserId: dto.targetUserId,
      };
    } catch (err: any) {
      this.logger.error(`Failed to initiate call: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * ACCEPT CALL
   * Recipient accepts call and sends SDP Answer to caller
   */
  @SubscribeMessage('call_accept')
  @SubscribeMessage('call:accept')
  async handleAcceptCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: AcceptCallDto,
  ) {
    const receiver: UserContext = client.data.user;
    if (!receiver) return { error: 'Unauthorized' };

    try {
      const callSession = await this.callsService.acceptCall(receiver, dto);

      // Emit accepted event to caller
      this.server.to(`user_${dto.targetUserId}`).emit('call_accepted', {
        callId: dto.callId,
        answer: dto.answer,
        recipientId: receiver.id,
        recipientName: receiver.name,
        answeredAt: callSession.answered_at,
      });

      this.logger.log(`Call accepted: ${dto.callId} by ${receiver.name}`);
      return { status: 'connected', callId: dto.callId };
    } catch (err: any) {
      this.logger.error(`Failed to accept call: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * REJECT CALL
   * Recipient declines incoming call
   */
  @SubscribeMessage('call_reject')
  @SubscribeMessage('call:reject')
  async handleRejectCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: RejectCallDto,
  ) {
    const user: UserContext = client.data.user;
    if (!user) return { error: 'Unauthorized' };

    try {
      await this.callsService.rejectCall(user, dto);

      // Notify caller that call was rejected
      this.server.to(`user_${dto.targetUserId}`).emit('call_rejected', {
        callId: dto.callId,
        reason: dto.reason || 'declined',
        rejectedBy: user.id,
      });

      return { status: 'rejected', callId: dto.callId };
    } catch (err: any) {
      this.logger.error(`Failed to reject call: ${err.message}`);
      return { error: err.message };
    }
  }

  /**
   * END CALL / HANGUP
   * Either party hangs up
   */
  @SubscribeMessage('call_end')
  @SubscribeMessage('call:end')
  async handleEndCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: EndCallDto,
  ) {
    const user: UserContext = client.data.user;
    if (!user) return { error: 'Unauthorized' };

    try {
      let callId = dto.callId;
      if (!callId) {
        callId = this.callsService.getActiveCallIdForUser(user.id) || '';
        dto.callId = callId;
      }

      const active = callId ? this.callsService.getActiveCall(callId) : null;
      const { call, duration } = await this.callsService.endCall(user, dto);

      const targetUserId =
        dto.targetUserId ||
        (active ? (active.callerId === user.id ? active.receiverId : active.callerId) : null);

      const payload = {
        callId: call?.id || callId,
        duration,
        endedBy: user.id,
        reason: dto.reason || (active?.answeredAt ? 'normal' : 'cancelled_before_answer'),
      };

      // Notify both parties so both UIs dismiss the call popup immediately
      if (targetUserId) {
        this.server.to(`user_${targetUserId}`).emit('call_ended', payload);
      }
      this.server.to(`user_${user.id}`).emit('call_ended', payload);

      return { status: 'ended', duration };
    } catch (err: any) {
      this.logger.warn(`Handled call end gracefully: ${err.message}`);
      return { status: 'ended', duration: 0 };
    }
  }

  /**
   * ICE CANDIDATE EXCHANGE
   * Relays ICE candidates directly between peers
   */
  @SubscribeMessage('call_ice_candidate')
  @SubscribeMessage('ice_candidate')
  @SubscribeMessage('call:ice-candidate')
  handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: IceCandidateDto,
  ) {
    const user: UserContext = client.data.user;
    if (!user || !dto?.targetUserId || !dto?.candidate) return;

    this.server.to(`user_${dto.targetUserId}`).emit('call_ice_candidate', {
      callId: dto.callId,
      candidate: dto.candidate,
      fromUserId: user.id,
    });
  }

  /**
   * TOGGLE AUDIO MUTE
   */
  @SubscribeMessage('call_toggle_mute')
  @SubscribeMessage('call:toggle-mute')
  handleToggleMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; targetUserId: string; isMuted: boolean },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data?.targetUserId) return;

    this.server.to(`user_${data.targetUserId}`).emit('call_peer_media_toggle', {
      callId: data.callId,
      mediaType: 'audio',
      isEnabled: !data.isMuted,
      fromUserId: user.id,
    });
  }

  /**
   * TOGGLE VIDEO ON/OFF
   */
  @SubscribeMessage('call_toggle_video')
  @SubscribeMessage('call:toggle-video')
  handleToggleVideo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; targetUserId: string; isVideoOff: boolean },
  ) {
    const user: UserContext = client.data.user;
    if (!user || !data?.targetUserId) return;

    this.server.to(`user_${data.targetUserId}`).emit('call_peer_media_toggle', {
      callId: data.callId,
      mediaType: 'video',
      isEnabled: !data.isVideoOff,
      fromUserId: user.id,
    });
  }

  /**
   * Helper to extract JWT token from client handshake
   */
  private extractToken(client: Socket): string | null {
    const authHeader =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization ||
      client.handshake.query?.token;

    if (typeof authHeader === 'string') {
      if (authHeader.startsWith('Bearer ')) {
        return authHeader.split(' ')[1];
      }
      return authHeader;
    }
    return null;
  }
}
