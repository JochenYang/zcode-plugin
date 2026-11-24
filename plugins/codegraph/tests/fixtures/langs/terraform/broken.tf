resource "aws_instance" {
  ami           =
  instance_type = t3.micro
  tags = {
    Name = "broken
  }

module "net" {
  source = "./modules/net"
  cidr   = var.cidr
}

output {
  value = aws_instance.
