import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  collectCoverage: true,
  coveragePathIgnorePatterns: [
    '/test/',
    '/node_modules/',
  ],
  coverageProvider: 'babel',
  moduleFileExtensions: [
    'ts',
    'js',
  ],
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/test/**/*-test.ts',
  ],
  transform: {
    '\\.ts$': [ 'ts-jest', {
      // Enabling this can fix issues when using prereleases of typings packages
      // isolatedModules: true
    }],
  },
  // The default test timeout is not enough for engine tests, but is enough for packages
  testTimeout: 20_000,
  globalSetup: '<rootDir>/test/globalSetup.ts',
  globalTeardown: '<rootDir>/test/globalTeardown.ts',
};

export default config;
