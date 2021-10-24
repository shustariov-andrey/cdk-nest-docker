import { Construct, Duration, Stack, StackProps } from '@aws-cdk/core';
import { Repository, TagStatus } from '@aws-cdk/aws-ecr';
import { BuildSpec, EventAction, FilterGroup, LinuxBuildImage, Project, Source } from '@aws-cdk/aws-codebuild';
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import * as path from 'path';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { AwsLogDriver, Cluster, ContainerImage, FargateTaskDefinition, Protocol } from '@aws-cdk/aws-ecs';
import { RetentionDays } from '@aws-cdk/aws-logs';
import { Effect, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns';
import { Artifact, ArtifactPath, Pipeline } from '@aws-cdk/aws-codepipeline';
import { CodeBuildAction, EcrSourceAction, EcsDeployAction } from '@aws-cdk/aws-codepipeline-actions';
import { Rule } from '@aws-cdk/aws-events';
import { CodePipeline } from '@aws-cdk/aws-events-targets';

interface ApplicationStackProps extends StackProps {
  branchName: string;
}

export class ApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    const appName = 'NestApp';
    const gitOwner = 'shustariov-andrey';
    const gitRepo = 'nest-docker-boilerplate';
    const branchName = props.branchName;

    const ecrRepository = new Repository(this, 'EcrRepo', {
      lifecycleRules: [{
        maxImageAge: Duration.days(30),
        rulePriority: 1,
        tagStatus: TagStatus.ANY,
        description: 'Expire images in 30 days'
      }]
    });

    const stubImage = new DockerImageAsset(this, 'StubImage', {
      directory: path.join(__dirname, '../images/stub-image'),
    });

    new ECRDeployment(this, 'StubImageDpl', {
      src: new DockerImageName(stubImage.imageUri),
      dest: new DockerImageName(`${ecrRepository.repositoryUri}:latest`),
    });

    const gitHubSource = Source.gitHub({
      owner: gitOwner,
      repo: gitRepo,
      webhook: true,
      webhookFilters: [
        FilterGroup.inEventOf(EventAction.PUSH).andBranchIs(branchName)
      ],
    });

    const project = new Project(this, `ImgBuilder`, {
      source: gitHubSource,
      environment: {
        buildImage: LinuxBuildImage.STANDARD_5_0,
        privileged: true
      },
      environmentVariables: {
        IMAGE_NAME: {
          value: ecrRepository.repositoryName
        },
        ECR_REPO_URI: {
          value: ecrRepository.repositoryUri
        }
      },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: {
          shell: 'bash'
        },
        phases: {
          pre_build: {
            commands: [
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',
              'export BUILD_NUMBER=${CODEBUILD_BUILD_NUMBER}',
              'env'
            ]
          },
          build: {
            commands: [
              'docker build --build-arg BUILD_NUMBER=$BUILD_NUMBER -t $IMAGE_NAME:$TAG .',
              'docker tag $IMAGE_NAME:$TAG $ECR_REPO_URI:$TAG',
              'docker tag $IMAGE_NAME:$TAG $ECR_REPO_URI:$BUILD_NUMBER',
              'docker tag $IMAGE_NAME:$TAG $ECR_REPO_URI:latest',
              '(aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REPO_URI)',
              'docker push $ECR_REPO_URI '
            ]
          }
        }
      })
    });

    ecrRepository.grantPullPush(project.role!);

    const vpc = new Vpc(this, `Vpc`, {
      // cidr: vpcCidr,
      maxAzs: 3,
      natGateways: 0,
    });

    const clusterName = `Cluster`;
    const cluster = new Cluster(this, clusterName, {
      vpc,
      containerInsights: true,
    });

    const logging = new AwsLogDriver({
      streamPrefix: appName,
      logRetention: RetentionDays.ONE_MONTH,
    });

    const taskRole = new Role(this, `ECSTaskRole`, {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    const taskRolePolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: ['*'],
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ]
    });

    const taskDef = new FargateTaskDefinition(this, `TaskDef`, {
      taskRole,
    });

    taskDef.addToExecutionRolePolicy(taskRolePolicy);

    const container = taskDef.addContainer(`ECSContainer`, {
      image: ContainerImage.fromEcrRepository(ecrRepository),
      memoryLimitMiB: 512,
      cpu: 256,
      logging,
      portMappings: [{
        containerPort: 3000,
        protocol: Protocol.TCP
      }]
    });

    const serviceName = `ECSService`;
    const fargateService = new ApplicationLoadBalancedFargateService(this, serviceName, {
      cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: true,
      desiredCount: 1,
      listenerPort: 80,
      assignPublicIp: true,
      taskSubnets: {
        subnetType: SubnetType.PUBLIC
      },
    });

    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 4 });
    scaling.scaleOnCpuUtilization(`CpuScaling`, {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60)
    });
    scaling.scaleOnMemoryUtilization(`MemScaling`, {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60)
    });

    const sourceOutput = new Artifact();
    const buildOutput = new Artifact();

    const ecrSourceAction = new EcrSourceAction({
      actionName: 'EcrSource',
      output: sourceOutput,
      repository: ecrRepository,
    });

    const buildAction = new CodeBuildAction({
      actionName: 'Build',
      project: new Project(this, `ImgDefBuilder`, {
        environment: {
          buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
          privileged: false,
        },
        environmentVariables: {
          IMAGE_NAME: {
            value: ecrRepository.repositoryName
          },
          ECR_REPO_URI: {
            value: ecrRepository.repositoryUri
          }
        },
        buildSpec: BuildSpec.fromObject({
          version: '0.2',
          phases: {
            post_build: {
              commands: [
                'echo "In Post-Build Stage"',
                `printf \'[{"name":"${container.containerName}","imageUri":"%s"}]\' $ECR_REPO_URI:latest > imagedefinitions.json`,
                'pwd; ls -al; cat imagedefinitions.json'
              ]
            }
          },
          artifacts: {
            files: [
              'imagedefinitions.json'
            ]
          }
        })
      }),
      input: sourceOutput,
      outputs: [buildOutput]
    });

    const deployAction = new EcsDeployAction({
      actionName: 'Deploy',
      service: fargateService.service,
      imageFile: new ArtifactPath(buildOutput, `imagedefinitions.json`)
    });

    const pipelineName = `DeployImgOnECS`;
    const pipeline = new Pipeline(this, pipelineName, {
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [{
        stageName: 'Source',
        actions: [ecrSourceAction],
      },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Deploy',
          actions: [deployAction],
        }]
    });

    // Why rule is needed: https://github.com/aws/aws-cdk/issues/10901#issuecomment-758976269
    const eventRule = new Rule(this, `${pipelineName}Trigger`, {
      eventPattern: {
        source: ['aws.ecr'],
        detail: {
          'action-type': ['PUSH'],
          'image-tag': ['latest'],
          'repository-name': [ecrRepository.repositoryName],
          result: ['SUCCESS'],
        },
      }
    });
    eventRule.addTarget(new CodePipeline(pipeline));
  }
}
