import { CfnOutput, Construct, Duration, Stack, StackProps, Tags } from '@aws-cdk/core';
import { SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { AwsLogDriver, Cluster, ContainerImage, FargateTaskDefinition, Protocol } from '@aws-cdk/aws-ecs';
import { Effect, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns';
import { Repository } from '@aws-cdk/aws-ecr';
import { Artifact, ArtifactPath, Pipeline } from '@aws-cdk/aws-codepipeline';
import { CodeBuildAction, EcrSourceAction, EcsDeployAction } from '@aws-cdk/aws-codepipeline-actions';
import { BuildSpec, LinuxBuildImage, Project } from '@aws-cdk/aws-codebuild';
import { Rule } from '@aws-cdk/aws-events';
import { CodePipeline } from '@aws-cdk/aws-events-targets';
import { RetentionDays } from '@aws-cdk/aws-logs';

interface ECSEnvironmentStackProps extends StackProps {
  appName: string;
  imageTag: string;
  ecrRepoName: string
  vpcCidr: string;
}

export class ECSEnvironmentStack extends Stack {
  constructor(scope: Construct, id: string, props: ECSEnvironmentStackProps) {
    super(scope, id, props);
    const appName = props.appName;
    const imageTag = props.imageTag;
    const ecrRepoName = props.ecrRepoName;
    const vpcCidr = props.vpcCidr;

    Tags.of(this).add('project', appName);
    Tags.of(this).add('env', imageTag);

    const vpc = new Vpc(this, `${appName}-${imageTag}-Vpc`, {
      cidr: vpcCidr,
      maxAzs: 3,
      natGateways: 0,
    });
    Tags.of(vpc).add('Name', `${appName}-${imageTag}-Vpc`)

    const clusterName = `${appName}-${imageTag}-Cluster`;
    const cluster = new Cluster(this, clusterName, {
      clusterName,
      vpc,
      containerInsights: true,
    });

    const logging = new AwsLogDriver({
      streamPrefix: appName,
      logRetention: RetentionDays.ONE_MONTH,
    });

    const taskRole = new Role(this, `${clusterName}TaskRole`, {
      roleName: `${clusterName}TaskRole`,
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

    const taskDef = new FargateTaskDefinition(this, `${clusterName}TaskDef`, {
      taskRole,
    });

    taskDef.addToExecutionRolePolicy(taskRolePolicy);

    const ecrRepository = Repository.fromRepositoryName(this, `${clusterName}EcrRepository`, ecrRepoName);

    const container = taskDef.addContainer(`${appName}-${imageTag}-Container`, {
      image: ContainerImage.fromEcrRepository(ecrRepository, imageTag),
      memoryLimitMiB: 512,
      cpu: 256,
      logging,
      portMappings: [{
        containerPort: 3000,
        protocol: Protocol.TCP
      }]
    });

    const serviceName = `${appName}-${imageTag}-Service`;
    const fargateService = new ApplicationLoadBalancedFargateService(this, serviceName, {
      serviceName: serviceName,
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
    scaling.scaleOnCpuUtilization(`${serviceName}CpuScaling`, {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60)
    });
    scaling.scaleOnMemoryUtilization(`${serviceName}MemoryScaling`, {
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
      imageTag,
    });

    const buildAction = new CodeBuildAction({
      actionName: 'Build',
      project: new Project(this, `${appName}-${imageTag}-ImageDefinitionsBuilder`, {
        projectName: `${appName}-${imageTag}-ImageDefinitionsBuilder`,
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
                `printf \'[{"name":"${container.containerName}","imageUri":"%s"}]\' $ECR_REPO_URI:${imageTag} > imagedefinitions.json`,
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

    const pipelineName = `${serviceName}-${imageTag}-DeployPipeline`;
    const pipeline = new Pipeline(this, pipelineName, {
      pipelineName,
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
          'image-tag': [imageTag],
          'repository-name': [ecrRepository.repositoryName],
          result: ['SUCCESS'],
        },
      }
    });
    eventRule.addTarget(new CodePipeline(pipeline));

    new CfnOutput(this, `${appName}-${imageTag}-LoadBalancerDNS`, { value: fargateService.loadBalancer.loadBalancerDnsName });
  }
}
