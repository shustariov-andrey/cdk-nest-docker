import { Construct, StackProps, Stage } from '@aws-cdk/core';
import { ApplicationStack } from './application-stack';

interface PipelineAppStageProps extends StackProps {
  branchName: string;
}

export class PipelineAppStage extends Stage {
  constructor(scope: Construct, id: string, props: PipelineAppStageProps) {
    super(scope, id, props);
    new ApplicationStack(this, 'AppStack', {
      branchName: props.branchName,
    });
  }
}
