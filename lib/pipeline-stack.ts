import { Construct, SecretValue, Stack, StackProps } from '@aws-cdk/core';
import { CodePipeline, CodePipelineSource, ShellStep } from '@aws-cdk/pipelines';
import { PipelineAppStage } from './pipeline-app-stage';

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const gitOwner = 'shustariov-andrey';
    const gitRepo = 'cdk-nest-docker';

    const pipeline = new CodePipeline(this, 'StackPipeline', {
      pipelineName: 'StackPipeline',
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.gitHub(`${gitOwner}/${gitRepo}`, 'master', {
          authentication: SecretValue.secretsManager('/NestApp', {
            jsonField: 'github-oauth-token'
          })
        }),
        commands: ['npm ci', 'npm run build', 'npx cdk synth']
      })
    });

    pipeline.addStage(new PipelineAppStage(this, 'NestAppProd', {
      branchName: 'master'
    }));

    pipeline.addStage(new PipelineAppStage(this, 'NestAppStaging', {
      branchName: 'develop'
    }));
  }
}
