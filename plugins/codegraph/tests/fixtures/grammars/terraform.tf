terraform {
  required_version = ">= 1.5.0"
}

variable "name" {
  type    = string
  default = "world"
}

resource "local_file" "greeting" {
  filename = "greeting.txt"
  content  = "Hello, ${var.name}!"
}

output "greeting" {
  value = local_file.greeting.content
}
