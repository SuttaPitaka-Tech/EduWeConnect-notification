import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const client: Socket = context.switchToWs().getClient();
    const token = this.extractToken(client);

    if (!token) {
      this.logger.warn(`WS connection rejected: No authorization token provided`);
      throw new WsException('Unauthorized: No authorization token provided');
    }

    try {
      const secret = this.configService.get<string>('JWT_SECRET', 'secretKey');
      const payload = this.jwtService.verify(token, { secret });
      client.data.user = payload;
      return true;
    } catch (err: any) {
      this.logger.warn(`WS token verification failed: ${err.message}`);
      throw new WsException(`Unauthorized: Invalid token (${err.message})`);
    }
  }

  extractToken(client: Socket): string | null {
    // 1. Check socket.handshake.auth
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
