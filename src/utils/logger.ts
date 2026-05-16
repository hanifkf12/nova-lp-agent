import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function errSerializer(this: any, key: string, value: any): any {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split('\n').slice(0, 3).join(' | '),
    };
  }
  return value;
}

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json({ replacer: errSerializer }),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const safe = JSON.parse(JSON.stringify(meta, errSerializer));
          const extras = Object.keys(safe).length ? ' ' + JSON.stringify(safe) : '';
          return `${timestamp} [${level}] ${message}${extras}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'nova.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 7,
    }),
  ],
});
