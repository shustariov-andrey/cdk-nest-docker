#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ECSEnvironmentStack } from '../lib/ecs-environment-stack';
import { ImageBuilderStack } from '../lib/image-builder-stack';

const app = new cdk.App();
new ECSEnvironmentStack(app, 'AwsNestDockerStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  appName: 'NestApp',
  imageTag: 'prod',
  vpcCidr: '10.0.0.0/16',
  ecrRepoName: 'nest-cluster-repo',
});
new ECSEnvironmentStack(app, 'AwsNestDockerDevStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  appName: 'NestApp',
  imageTag: 'dev',
  vpcCidr: '10.1.0.0/16',
  ecrRepoName: 'nest-cluster-repo',
});
new ImageBuilderStack(app, 'ImageBuilderStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  appName: 'NestApp',
  repoName: 'nest-cluster-repo',
  gitOwner: 'shustariov-andrey',
  gitRepo: 'nest-docker-boilerplate',
  branchMapping: {
    'master': 'prod',
    'develop': 'dev',
    '^release/.*': 'uat'
  }
});

