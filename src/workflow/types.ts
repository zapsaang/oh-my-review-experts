import type { ReviewDimensionType, SliceTypeValue } from "../config/schema.js";

export interface ReviewSlice {
  slice_id: string;
  slice_type: SliceTypeValue;
  title: string;
  files: string[];
}

export interface SlicePlan {
  status: "completed";
  slicing_mode: "none" | "module-based" | "risk-based" | "hybrid";
  should_slice: boolean;
  reason: string;
  slices: ReviewSlice[];
}

export interface EstimatedPlan {
  slices: ReviewSlice[];
  selectedReviewers: Record<string, ReviewDimensionType[]>;
  estimatedTasks: number;
  compactMode: boolean;
  useHierarchicalArbitration: boolean;
}
