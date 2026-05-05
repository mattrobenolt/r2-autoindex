terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_r2_bucket" "bucket" {
  account_id   = var.account_id
  name         = var.bucket_name
  jurisdiction = "default"
}

resource "cloudflare_queue" "events" {
  account_id = var.account_id
  queue_name = var.queue_name
}

resource "cloudflare_workers_script" "worker" {
  account_id          = var.account_id
  script_name         = var.worker_name
  content_file        = "${path.module}/worker.js"
  content_sha256      = filesha256("${path.module}/worker.js")
  main_module         = "worker.js"
  compatibility_date  = var.compatibility_date
  compatibility_flags = ["nodejs_compat"]

  bindings = [
    {
      name        = "BUCKET"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.bucket.name
    },
    {
      name = "R2_SERVE_CONFIG"
      type = "json"
      json = jsonencode(var.config)
    },
  ]
}

resource "cloudflare_queue_consumer" "worker" {
  account_id  = var.account_id
  queue_id    = cloudflare_queue.events.queue_id
  type        = "worker"
  script_name = cloudflare_workers_script.worker.script_name

  settings = {
    batch_size       = 100
    max_wait_time_ms = 5000
  }
}

resource "cloudflare_r2_bucket_event_notification" "listing_cache" {
  account_id   = var.account_id
  bucket_name  = cloudflare_r2_bucket.bucket.name
  jurisdiction = cloudflare_r2_bucket.bucket.jurisdiction
  queue_id     = cloudflare_queue.events.queue_id

  rules = [
    {
      actions     = ["PutObject", "CopyObject", "CompleteMultipartUpload"]
      description = "Invalidate directory listing cache on object create/update"
      prefix      = ""
      suffix      = ""
    },
    {
      actions     = ["DeleteObject", "LifecycleDeletion"]
      description = "Invalidate directory listing cache on object delete"
      prefix      = ""
      suffix      = ""
    },
  ]
}

resource "cloudflare_workers_custom_domain" "worker" {
  count = var.hostname == null ? 0 : 1

  account_id = var.account_id
  hostname   = var.hostname
  service    = cloudflare_workers_script.worker.script_name
  zone_id    = var.zone_id
}
