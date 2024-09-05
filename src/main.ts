import { App } from 'aws-cdk-lib';
import { OneDevStack } from './onedev-stack';

const app = new App();

new OneDevStack(app, 'onedev-on-ecs', {
  env: {
    region: process.env.AWS_REGION,
    account: process.env.AWS_ACCOUNT,
  },
});

app.synth();
