import type { ReviewDimensionType, SliceTypeValue } from "../config/schema.js";

export interface ReviewSlice {
  slice_id: string;
  slice_type: SliceTypeValue;
  title: string;
  files: string[];
}

export interface EstimatedPlan {
  slices: ReviewSlice[];
  selectedReviewers: Record<string, ReviewDimensionType[]>;
  estimatedTasks: number;
  compactMode: boolean;
  useHierarchicalArbitration: boolean;
}
