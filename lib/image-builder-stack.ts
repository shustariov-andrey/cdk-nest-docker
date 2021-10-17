import { CfnParameter, Construct, Duration, SecretValue, Stack, StackProps, Tags } from '@aws-cdk/core';
import {
  BuildSpec,
  EventAction,
  FilterGroup,
  GitHubSourceCredentials,
  LinuxBuildImage,
  Project,
  Source
} from '@aws-cdk/aws-codebuild';
import { Repository, TagStatus } from '@aws-cdk/aws-ecr';

interface ImageBuilderStackProps extends StackProps {
  appName: string;
  repoName: string;
  branchMapping: Record<string, string>;
  gitOwner: string;
  gitRepo: string;
}

export class ImageBuilderStack extends Stack {
  constructor(scope: Construct, id: string, props: ImageBuilderStackProps) {
    super(scope, id, props);

    const { appName, repoName, gitRepo, gitOwner, branchMapping } = props;

    Tags.of(this).add('project', appName);

    const ecrRepository = new Repository(this, `${appName}EcrRepository`, {
      repositoryName: repoName,
      lifecycleRules: [{
        maxImageAge: Duration.days(30),
        rulePriority: 1,
        tagStatus: TagStatus.ANY,
        description: 'Expire images in 30 days'
      }]
    });

    const githubToken = new CfnParameter(this, 'GithubToken', {
      type: 'String',
    });

    new GitHubSourceCredentials(this, `${appName}GitHubCredentials`, {
      accessToken: SecretValue.plainText(githubToken.valueAsString),
    });

    const gitHubSource = Source.gitHub({
      owner: gitOwner,
      repo: gitRepo,
      webhook: true,
      webhookFilters: Object.keys(branchMapping).map(
        branchPattern => FilterGroup.inEventOf(EventAction.PUSH).andBranchIs(branchPattern)
      ),
    });

    const project = new Project(this, `${appName}BuildProject`, {
      projectName: `${appName}BuildProject`,
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
              'export CODEBUILD_GIT_BRANCH="$(git symbolic-ref HEAD --short 2>/dev/null)"',
              `if [ "$CODEBUILD_GIT_BRANCH" = "" ] ; then
                export CODEBUILD_GIT_BRANCH="$(git rev-parse HEAD | xargs git name-rev | cut -d\' \' -f2 | sed \'s/remotes\\/origin\\///g\')";
              fi`,
              ...Object.entries(branchMapping).map(([branchPattern, tagName]) =>
                `if [[ "$CODEBUILD_GIT_BRANCH" =~ ${branchPattern} ]] ; then
                   export ENV_TAG=${tagName};
                fi`
              ),
              'env'
            ]
          },
          build: {
            commands: [
              'docker build --build-arg BUILD_NUMBER=$BUILD_NUMBER -t $IMAGE_NAME:$TAG .',
              'docker tag $IMAGE_NAME:$TAG $ECR_REPO_URI:$TAG',
              'docker tag $IMAGE_NAME:$TAG $ECR_REPO_URI:$BUILD_NUMBER',
              'docker tag $IMAGE_NAME:$TAG $ECR_REPO_URI:$ENV_TAG',
              '(aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REPO_URI)',
              'docker push $ECR_REPO_URI '
            ]
          }
        }
      })
    });

    ecrRepository.grantPullPush(project.role!);

  }
}
