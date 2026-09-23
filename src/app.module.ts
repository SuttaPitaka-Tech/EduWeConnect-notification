import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MinioModule } from './minio/minio.module';
import { ChatModule } from './chat/chat.module';
import { Conversation, Participant, Message, Attachment } from './chat/entities';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: 'environment/.env.local',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get<string>('DB_HOST', '127.0.0.1'),
        port: parseInt(configService.get<string>('DB_PORT', '3306'), 10),
        username: configService.get<string>('DB_USER', 'root'),
        password: configService.get<string>('DB_PASSWORD', 'Punith@1234'),
        database: configService.get<string>('DB_NAME', 'eduweconn-notification-service'),
        entities: [Conversation, Participant, Message, Attachment],
        synchronize: true, // Auto-creates tables in MySQL
      }),
    }),
    MinioModule,
    ChatModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
