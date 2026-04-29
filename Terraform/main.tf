terraform {
  required_providers { aws = { source = "hashicorp/aws" } }
}
provider "aws" { region = "ap-southeast-1" }

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"
  cluster_name = "shopline-demo"
  cluster_version = "1.30"
  vpc_id     = "vpc-12345678"
  subnet_ids = ["subnet-1111","subnet-2222"]
  enable_cluster_creator_admin_permissions = true
}
output "endpoint" { value = module.eks.cluster_endpoint }