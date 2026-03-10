/**
 * Centralized configuration from environment variables
 */

export interface AppConfig {
  databaseUrl: string;
  transport: 'http' | 'stdio';
  port: number;
  autoArchiveEnabled: boolean;
  autoArchiveDays: number;
  autoBackupEnabled: boolean;
  backupIntervalMs: number;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory',
    transport: (process.env.MEMORY_TRANSPORT as 'http' | 'stdio') || 'http',
    port: parseInt(process.env.MEMORY_PORT || '3846', 10),
    autoArchiveEnabled: process.env.MEMORY_AUTO_ARCHIVE !== 'false',
    autoArchiveDays: parseInt(process.env.MEMORY_AUTO_ARCHIVE_DAYS || '14', 10),
    autoBackupEnabled: process.env.MEMORY_AUTO_BACKUP !== 'false',
    backupIntervalMs: parseInt(process.env.MEMORY_BACKUP_INTERVAL || '3600000', 10),
  };
}
