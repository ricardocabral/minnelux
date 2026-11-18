import {
  S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function connect(config, credentials, abortSignal) {
  const client = new S3Client({
    region: config.region, credentials, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = config.bucket;
  const request = { abortSignal };
  return {
    read(Key, Range) {
      return client.send(new GetObjectCommand({ Bucket, Key, Range }), request);
    },
    stat(Key) {
      return client.send(new HeadObjectCommand({ Bucket, Key }), request);
    },
    list(Prefix, ContinuationToken) {
      return client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken, MaxKeys: 1 }), request);
    },
    put(Key, value, etag) {
      return client.send(new PutObjectCommand({
        Bucket, Key, Body: JSON.stringify(value), ContentType: 'application/json',
        IfNoneMatch: etag === undefined ? '*' : undefined,
        IfMatch: etag,
      }), request);
    },
    async mediaUrl(Key, lifetime = 300) {
      abortSignal.throwIfAborted();
      const remaining = Math.floor((credentials.expiration.getTime() - Date.now()) / 1000) - 5;
      const expiresIn = Math.min(lifetime, remaining);
      if (expiresIn < 1) throw new Error('AWS credentials are about to expire. Sign in again.');
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn });
      abortSignal.throwIfAborted();
      return { url, expiresAt: Date.now() + expiresIn * 1000 };
    },
  };
}
