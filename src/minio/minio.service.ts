import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly s3Client: S3Client;
  private readonly logger = new Logger(MinioService.name);
  private readonly defaultBucket = process.env.S3_BUCKET_NAME || 'eduwecon-default-bucket';

  constructor() {
    this.s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin123',
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
  }

  async onModuleInit() {
    await this.ensureBucketExists(this.defaultBucket);
  }

  private async ensureBucketExists(bucketName: string) {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      this.logger.log(`Bucket "${bucketName}" exists.`);
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        this.logger.log(`Bucket "${bucketName}" not found. Creating it...`);
        try {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
          this.logger.log(`Bucket "${bucketName}" created successfully.`);
        } catch (createError) {
          this.logger.error(`Failed to create bucket "${bucketName}"`, createError);
        }
      } else {
        this.logger.error(`Error checking bucket "${bucketName}"`, error);
      }
    }
  }

  async uploadFile(fileBuffer: Buffer, fileName: string, mimeType: string, bucket: string = this.defaultBucket) {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: fileName,
      Body: fileBuffer,
      ContentType: mimeType,
    });
    return this.s3Client.send(command);
  }

  async getFileUrl(fileName: string, bucket: string = this.defaultBucket, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: fileName,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async deleteFile(fileName: string, bucket: string = this.defaultBucket) {
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: fileName,
    });
    return this.s3Client.send(command);
  }
}
