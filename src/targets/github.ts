import { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import { createReadStream, promises, statSync } from 'fs';
import { basename } from 'path';

import { getConfiguration } from '../config';
import {
  ChangelogPolicy,
  GitHubGlobalConfig,
  TargetConfig,
} from '../schemas/project_config';
import {
  Changeset,
  DEFAULT_CHANGELOG_PATH,
  findChangeset,
} from '../utils/changelog';
import { getGitHubClient } from '../utils/githubApi';
import { isDryRun } from '../utils/helpers';
import { isPreviewRelease, versionToTag } from '../utils/version';
import { BaseTarget } from './base';
import { BaseArtifactProvider } from '../artifact_providers/base';
import { logger } from '../logger';

/**
 * Default content type for GitHub release assets.
 */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Configuration options for the GitHub target.
 */
export interface GitHubTargetConfig extends GitHubGlobalConfig {
  /** Path to changelog inside the repository */
  changelog: string;
  /** Prefix that will be used to generate tag name */
  tagPrefix: string;
  /** Mark release as pre-release, if the version looks like a non-public release */
  previewReleases: boolean;
}

/**
 * An interface that represents a minimal GitHub release as returned by the
 * GitHub API.
 */
interface GitHubRelease {
  /** Release id */
  id: number;
  /** Tag name */
  tag_name: string;
  /** Upload URL */
  upload_url: string;
}

type ReposListAssetsForReleaseResponseItem = RestEndpointMethodTypes['repos']['listReleaseAssets']['response']['data'][0];

interface OctokitError {
  resource: string;
  field: string;
  code:
    | 'missing'
    | 'missing_field'
    | 'invalid'
    | 'already_exists'
    | 'unprocessable'
    | 'custom';
  message?: string;
}
interface OctokitErrorResponse {
  message: string;
  errors: OctokitError[];
  documentation_url?: string;
}

/**
 * Target responsible for publishing releases on GitHub.
 */
export class GitHubTarget extends BaseTarget {
  /** Target name */
  public readonly name = 'github';
  /** Target options */
  public readonly githubConfig: GitHubTargetConfig;
  /** GitHub client */
  public readonly github: Octokit;
  /** GitHub repo configuration */
  public readonly githubRepo: GitHubGlobalConfig;

  public constructor(
    config: TargetConfig,
    artifactProvider: BaseArtifactProvider,
    githubRepo: GitHubGlobalConfig
  ) {
    super(config, artifactProvider, githubRepo);
    this.githubRepo = githubRepo;
    const owner = config.owner || githubRepo.owner;
    const repo = config.repo || githubRepo.repo;
    const changelog = getConfiguration().changelog || DEFAULT_CHANGELOG_PATH;

    this.githubConfig = {
      owner,
      repo,
      changelog,
      previewReleases:
        this.config.previewReleases === undefined ||
        !!this.config.previewReleases,
      tagPrefix: this.config.tagPrefix || '',
    };
    this.github = getGitHubClient();
  }

  /**
   * Create a draft release for the given version.
   *
   * The release name and description body is brought in from `changes`
   * respective tag, if present. Otherwise, the release name defaults to the
   * tag and the body to the commit it points to.
   *
   * @param version The version to release
   * @param revision Git commit SHA to be published
   * @param changes The changeset information for this release
   * @returns The newly created release
   */
  public async createDraftRelease(
    version: string,
    revision: string,
    changes?: Changeset
  ): Promise<GitHubRelease> {
    const tag = versionToTag(version, this.githubConfig.tagPrefix);
    this.logger.info(`Git tag: "${tag}"`);
    const isPreview =
      this.githubConfig.previewReleases && isPreviewRelease(version);

    if (isDryRun()) {
      this.logger.info(`[dry-run] Not creating the draft release`);
      return {
        id: 0,
        tag_name: tag,
        upload_url: '',
      };
    }

    const { data } = await this.github.repos.createRelease({
      draft: true,
      name: tag,
      owner: this.githubConfig.owner,
      prerelease: isPreview,
      repo: this.githubConfig.repo,
      tag_name: tag,
      target_commitish: revision,
      ...changes,
    });
    return data;
  }

  public async getChangelog(version: string): Promise<Changeset> {
    let changelog;
    try {
      changelog = (
        await promises.readFile(this.githubConfig.changelog)
      ).toString();
    } catch (err) {
      logger.error('Cannot read changelog, moving on without one', err);
    }
    const changes = (changelog && findChangeset(changelog, version)) || {
      name: version,
      body: '',
    };
    this.logger.debug('Changes extracted from changelog.');
    this.logger.trace(changes);

    return changes;
  }

  /**
   * Deletes the provided asset from its respective release
   *
   * Can also be used to delete orphaned (unfinished) releases
   *
   * @param asset Asset to delete
   */
  public async deleteAsset(
    asset: ReposListAssetsForReleaseResponseItem
  ): Promise<boolean> {
    this.logger.debug(`Deleting asset: "${asset.name}"...`);
    if (isDryRun()) {
      this.logger.info(`[dry-run] Not deleting "${asset.name}"`);
      return false;
    }

    return (
      (
        await this.github.repos.deleteReleaseAsset({
          asset_id: asset.id,
          ...this.githubConfig,
        })
      ).status === 204
    );
  }

  /**
   * Fetches a list of all assets for the given release
   *
   * The result includes unfinished asset uploads.
   *
   * @param release Release to fetch assets from
   */
  public async getAssetsForRelease(
    release_id: number
  ): Promise<ReposListAssetsForReleaseResponseItem[]> {
    const assetsResponse = await this.github.repos.listReleaseAssets({
      owner: this.githubConfig.owner,
      per_page: 50,
      release_id,
      repo: this.githubConfig.repo,
    });
    return assetsResponse.data;
  }

  /**
   * Deletes the asset with the given name from the specific release
   *
   * @param release Release object ID
   * @param assetName Asset name to be deleted
   */
  public async deleteAssetByName(
    release_id: number,
    assetName: string
  ): Promise<boolean> {
    const assets = await this.getAssetsForRelease(release_id);
    const assetToDelete = assets.find(({ name }) => name === assetName);
    if (!assetToDelete) {
      throw new Error(
        `No such asset with the name "${assetToDelete}". We have these instead: ${assets.map(
          ({ name }) => name
        )}`
      );
    }
    return this.deleteAsset(assetToDelete);
  }

  /**
   * Uploads the file from the provided path to the specific release
   *
   * @param release Release object
   * @param path Filesystem (local) path of the file to upload
   * @param contentType Optional content-type for uploading
   */
  public async uploadAsset(
    release: GitHubRelease,
    path: string,
    contentType?: string
  ): Promise<string | undefined> {
    const contentTypeProcessed = contentType || DEFAULT_CONTENT_TYPE;
    const stats = statSync(path);
    const name = basename(path);
    const params = {
      ...this.githubConfig,
      headers: {
        'Content-Length': stats.size,
        'Content-Type': contentTypeProcessed,
      },
      release_id: release.id,
      name,
    };
    this.logger.trace('Upload parameters:', params);

    if (isDryRun()) {
      this.logger.info(`[dry-run] Not uploading asset "${name}"`);
      return;
    }

    process.stderr.write(
      `Uploading asset "${name}" to ${this.githubConfig.owner}/${this.githubConfig.repo}:${release.tag_name}\n`
    );

    try {
      const file = createReadStream(path);
      const { url, size } = await this.handleGitHubUpload({
        ...params,
        // XXX: Octokit types this out as string, but in fact it also
        // accepts a `Buffer` here. In fact passing a string is not what we
        // want as we upload binary data.
        data: file as any,
      });
      if (size != stats.size) {
        throw new Error(
          `Uploaded asset size (${size} bytes) does not match local asset size (${stats.size} bytes) for "${name}".`
        );
      }
      process.stderr.write(`✔ Uploaded asset "${name}".\n`);
      return url;
    } catch (e) {
      process.stderr.write(`✖ Cannot upload asset "${name}".\n`);
      throw e;
    }
  }

  private async handleGitHubUpload(
    params: RestEndpointMethodTypes['repos']['uploadReleaseAsset']['parameters'],
    retries = 3
  ): Promise<{ url: string; size: number }> {
    try {
      return (await this.github.repos.uploadReleaseAsset(params)).data;
    } catch (err) {
      if (!(err instanceof RequestError)) {
        throw err;
      }

      // This usually happens when the upload gets interrupted somehow with a
      // 5xx error. See the docs here:
      // https://docs.github.com/en/rest/releases/assets#upload-a-release-asset
      const isAssetExistsError =
        err.status == 422 &&
        (err.response?.data as OctokitErrorResponse)?.errors?.some(
          ({ resource, code, field }) =>
            resource === 'ReleaseAsset' &&
            code === 'already_exists' &&
            field === 'name'
        );

      if (!isAssetExistsError) {
        throw err;
      }

      if (retries <= 0) {
        throw new Error(
          `Reached maximum retries for trying to upload asset "${params.name}.`
        );
      }

      logger.info('Got "asset already exists" error, deleting and retrying...');
      await this.deleteAssetByName(params.release_id, params.name);
      return this.handleGitHubUpload(params, --retries);
    }
  }

  /**
   * Publishes the draft release.
   *
   * @param release Release object
   */
  public async publishRelease(release: GitHubRelease) {
    if (isDryRun()) {
      this.logger.info(`[dry-run] Not publishing the draft release`);
      return;
    }

    await this.github.repos.updateRelease({
      ...this.githubConfig,
      release_id: release.id,
      draft: false,
    });
  }

  /**
   * Creates a new GitHub release and publish all available artifacts.
   *
   * It also creates a tag if it doesn't exist
   *
   * @param version New version to be released
   * @param revision Git commit SHA to be published
   */
  public async publish(version: string, revision: string): Promise<any> {
    const config = getConfiguration();
    let changelog;
    if (config.changelogPolicy !== ChangelogPolicy.None) {
      changelog = await this.getChangelog(version);
    }

    const artifacts = await this.getArtifactsForRevision(revision);
    const localArtifacts = await Promise.all(
      artifacts.map(async artifact => ({
        mimeType: artifact.mimeType,
        path: await this.artifactProvider.downloadArtifact(artifact),
      }))
    );

    const draftRelease = await this.createDraftRelease(
      version,
      revision,
      changelog
    );

    await Promise.all(
      localArtifacts.map(({ path, mimeType }) =>
        this.uploadAsset(draftRelease, path, mimeType)
      )
    );

    await this.publishRelease(draftRelease);
  }
}
