# Main networking stack for the web tier.
provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

locals {
  name_prefix = "${var.project}-${var.env}"
}

module "network" {
  source = "./modules/network"
  cidr   = var.vpc_cidr
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = local.instance_type
  subnet_id     = module.network.subnet_id
  tags          = { Name = local.name_prefix }
}

resource "aws_s3_bucket" "logs" {
  for_each = var.buckets
  bucket   = "${local.name_prefix}-${each.key}"
}

output "instance_id" {
  value = aws_instance.web.id
}
