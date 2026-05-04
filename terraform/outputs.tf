output "bucket_name" {
  value = cloudflare_r2_bucket.bucket.name
}

output "queue_name" {
  value = cloudflare_queue.events.queue_name
}

output "worker_name" {
  value = cloudflare_workers_script.worker.script_name
}

output "hostname" {
  value = var.hostname
}
