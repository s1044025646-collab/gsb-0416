/** 公开的资源上限，防止内存/存储无限增长。 */
export const LIMITS = {
  MAX_CAPACITY: 100_000, // 单个抽样器容量上限
  MAX_PAYLOAD_BYTES: 4096, // 单条载荷最大字节数
  MAX_BATCH_SIZE: 1000, // 单批最多条数
  MAX_TOTAL_COUNT: 0xffffffff, // 总记录数须落在 32 位随机整数范围内
  LOG_RETENTION: 100, // 每个抽样器保留的最近解释条数
  MAX_BODY_BYTES: 8 * 1024 * 1024, // HTTP 请求体上限
} as const;
