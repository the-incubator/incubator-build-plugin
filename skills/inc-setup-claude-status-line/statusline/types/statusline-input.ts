export interface StatusLineInput {
  model: {
    id: string;
    display_name: string;
  };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    used_percentage: number | null;
    remaining_percentage: number | null;
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    } | null;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
    added_dirs: string[];
  };
  output_style: {
    name: string;
  };
  effort?: {
    level: "low" | "medium" | "high" | "xhigh" | "max";
  };
  vim?: {
    enabled: boolean;
    mode?: string;
  };
  agent?: {
    name?: string;
  };
}
