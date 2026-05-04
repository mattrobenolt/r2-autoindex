variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket name to create and serve."
  type        = string
}

variable "worker_name" {
  description = "Worker script name."
  type        = string
}

variable "queue_name" {
  description = "Queue name for R2 event notifications."
  type        = string
}

variable "hostname" {
  description = "Optional custom hostname routed to the Worker."
  type        = string
  default     = null
}

variable "zone_id" {
  description = "Zone ID for hostname. Required when hostname is set."
  type        = string
  default     = null
}

variable "config" {
  description = "Standalone r2-serve JSON-compatible config."
  type        = any
  default     = {}
}

variable "compatibility_date" {
  description = "Worker compatibility date."
  type        = string
  default     = "2026-05-03"
}
