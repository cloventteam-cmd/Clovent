import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import { config } from '../shared/config';
import { uuid } from '../shared/utils';
import { logger } from '../shared/logger';

const useS3 = !!(config.storage.accessKey && config.storage.secretKey);

const s3 = useS3
  ? new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint || undefined,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
    })
  : null;

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'uploads');

export async function uploadFile(
  tenantId: string,
  filename: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ path: string; url: string; key: string }> {
  const key = `${tenantId}/${uuid()}-${filename}`;

  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    const url = `${config.storage.endpoint}/${config.storage.bucket}/${key}`;
    return { path: key, url, key };
  }

  // Local storage fallback
  const localPath = path.join(LOCAL_UPLOAD_DIR, key.replace(/\//g, '_'));
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(localPath);
    ws.write(buffer);
    ws.end();
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  return { path: localPath, url: `/uploads/${path.basename(localPath)}`, key };
}

export async function getPresignedUrl(key: string, expiresInSec = 3600): Promise<string> {
  if (!s3) return `/uploads/${key}`;

  const command = new GetObjectCommand({ Bucket: config.storage.bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSec });
}

export async function deleteFile(key: string): Promise<void> {
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return;
  }
  const { unlink } = await import('fs/promises');
  await unlink(key).catch(() => {});
}
