# Summary
Example of AWS CDK Stack, which establishes infrastructure and application environments (dev and prod) for GitFlow-based development process.
Deployable application is expected to have Dockerfile

# Usage
2. First bootstrap deploy `ImageBuilderStack` with GithubToken cfn param
3. Trigger CodeBuild project (or just push to the target repo)
4. Once image with required tag is present in ECR - deploy corresponding application stack
