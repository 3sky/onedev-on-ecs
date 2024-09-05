import * as cdk from 'aws-cdk-lib';
import * as acme from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';


export class OneDevStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('description', 'OneDev deployment');
    cdk.Tags.of(this).add('organization', '3sky.dev');
    cdk.Tags.of(this).add('owner', '3sky');
    cdk.Tags.of(this).add('CostCenter', 'onedev');

    let CUSTOM_IMAGE: string = '1dev/server:11.0.9';
    let DOMAIN_NAME: string = '3sky.in';

    const vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.192.0.0/26'),
      maxAzs: 2,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          cidrMask: 28,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 28,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const nlbSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: vpc,
      description: 'Allow HTTPS traffic to ALB',
      allowAllOutbound: true,
    });
    nlbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic from anywhere');
    nlbSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH traffic from anywhere');

    const privateSecurityGroup = new ec2.SecurityGroup(this, 'PrivateSG', {
      vpc: vpc,
      description: 'Allow access from NLB',
      allowAllOutbound: true,
    });

    privateSecurityGroup.addIngressRule(nlbSecurityGroup, ec2.Port.tcp(6610), 'Allow traffic for health checks');
    privateSecurityGroup.addIngressRule(nlbSecurityGroup, ec2.Port.tcp(6611), 'Allow traffic for SSH');

    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc: vpc,
      description: 'Allow access from cluster',
      allowAllOutbound: true,
    });
    efsSecurityGroup.addIngressRule(privateSecurityGroup, ec2.Port.tcp(2049), 'Allow traffic for EFS from cluster');

    const nlb = new elbv2.NetworkLoadBalancer(this, 'NetworkLB', {
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      internetFacing: true,
      securityGroups: [nlbSecurityGroup],
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: DOMAIN_NAME });

    new route53.CnameRecord(this, 'cnameForNlb', {
      recordName: 'git',
      zone: zone,
      domainName: nlb.loadBalancerDnsName,
      ttl: cdk.Duration.minutes(1),
    });

    const nlbcert = new acme.Certificate(this, 'Certificate', {
      domainName: 'git.' + DOMAIN_NAME,
      certificateName: 'Testing keyclock service', // Optionally provide an certificate name
      validation: acme.CertificateValidation.fromDns(zone),
    });


    const fileSystem = new efs.FileSystem(this, 'EfsFilesystem', {
      vpc,
      securityGroup: efsSecurityGroup,
    });

    var accessPoint = new efs.AccessPoint(this, 'VolumeAccessPoint', {
      fileSystem: fileSystem,
      path: '/opt/onedev',
      // app is running as root
      createAcl: {
        ownerGid: '0',
        ownerUid: '0',
        permissions: '755',
      },
      posixUser: {
        uid: '0',
        gid: '0',
      },
    });

    const volume = {
      name: 'volume',
      efsVolumeConfiguration: {
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
      },
    };

    const ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: 'onedev-ecs-cluster',
      containerInsights: true,
      enableFargateCapacityProviders: true,
      vpc: vpc,
    });

    const ecsTaskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
      volumes: [volume],
    });


    const container = ecsTaskDefinition.addContainer('onedev', {
      image: ecs.ContainerImage.fromRegistry(CUSTOM_IMAGE),
      portMappings: [
        {
          containerPort: 6610,
          protocol: ecs.Protocol.TCP,
        },
        {
          containerPort: 6611,
          protocol: ecs.Protocol.TCP,
        },
      ],
      logging: new ecs.AwsLogDriver({ streamPrefix: 'onedev' }),
    });


    container.addMountPoints({
      readOnly: false,
      containerPath: '/opt/onedev',
      sourceVolume: volume.name,
    });

    const ecsService = new ecs.FargateService(this, 'EcsService', {
      cluster: ecsCluster,
      taskDefinition: ecsTaskDefinition,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [
        privateSecurityGroup,
      ],
    });

    const listener = nlb.addListener('Listener443', {
      port: 443,
      certificates: [nlbcert],
      protocol: elbv2.Protocol.TLS,
    });

    const listener22 = nlb.addListener('Listener22', {
      port: 22,
      protocol: elbv2.Protocol.TCP,
    });


    listener22.addTargets('ECS-22', {
      port: 6611,
      protocol: elbv2.Protocol.TCP,
      targets: [ecsService],
    });

    listener.addTargets('ECS-443', {
      port: 6610,
      protocol: elbv2.Protocol.TCP,
      targets: [ecsService],
    });
  }
}
