export function createLogger() {
  const lines: { level: string; message: string }[] = []
  return {
    lines,
    logger: {
      level: "debug" as const,
      log: (level: string, message: string) => {
        lines.push({ level, message })
      },
    },
  }
}
