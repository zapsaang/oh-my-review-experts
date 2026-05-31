export interface RawLocation {
  path: string;
  line?: number | string;
}

export interface RawFinding {
  reviewer: string;
  severity: string;
  category: string;
  title: string;
  problem: string;
  evidence?: string;
  recommendation?: string;
  id?: string;
  confidence?: string;
  locations: RawLocation[];
}

export class MemoryExtractionError extends Error {
  sourcePath: string;

  constructor(message: string, sourcePath: string, cause?: Error) {
    super(message, { cause });
    this.name = "MemoryExtractionError";
    this.sourcePath = sourcePath;
  }
}
