import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 7003;
  await app.listen(port);
  Logger.log(`🚀 EduWeConnect Notification service is running on: http://localhost:${port}`);
}
bootstrap();
