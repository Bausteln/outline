import { GroupPermission } from "@shared/types";
import { traceFunction } from "@server/logging/tracing";
import { Group, GroupUser, User, Team } from "@server/models";
import { sequelize } from "@server/storage/database";
import Logger from "@server/logging/Logger";
import { APIContext } from "@server/types";

type Props = {
  /** The user to synchronize groups for */
  user: User;
  /** The team the user belongs to */
  team: Team;
  /** Array of group names from the external provider (e.g., OIDC) */
  externalGroups: string[];
  /** The authentication provider name (e.g., "oidc") - used to track which groups are managed */
  authProviderName: string;
};

export type GroupSynchronizerResult = {
  /** Groups that were created */
  created: Group[];
  /** Groups the user was added to */
  added: Group[];
  /** Groups the user was removed from */
  removed: Group[];
};

/**
 * Synchronizes a user's group memberships based on external group data.
 *
 * This function:
 * 1. Creates groups that don't exist (using externalId for tracking)
 * 2. Adds the user to groups they should be in
 * 3. Removes the user from externally-managed groups they're no longer in
 */
async function groupSynchronizer(
  ctx: APIContext,
  { user, team, externalGroups, authProviderName }: Props
): Promise<GroupSynchronizerResult> {
  const result: GroupSynchronizerResult = {
    created: [],
    added: [],
    removed: [],
  };

  return await sequelize.transaction(async (transaction) => {
    // Step 1: Find or create groups based on externalId
    const groupPromises = externalGroups.map(async (groupName) => {
      // Use the group name as the externalId for OIDC groups
      const externalId = `${authProviderName}:${groupName}`;

      // First, try to find by externalId
      let group = await Group.findOne({
        where: {
          teamId: team.id,
          externalId,
        },
        transaction,
      });

      // If not found by externalId, try to find by name (case-insensitive)
      if (!group) {
        group = await Group.findOne({
          where: {
            teamId: team.id,
            name: sequelize.where(
              sequelize.fn("LOWER", sequelize.col("name")),
              sequelize.fn("LOWER", groupName)
            ),
          },
          transaction,
        });

        // If found by name, update the externalId to claim this group
        if (group) {
          await group.update(
            {
              externalId,
              description: `Automatically synchronized from ${authProviderName}`,
            },
            { transaction }
          );
          Logger.info(
            "groupSynchronizer",
            `Updated existing group "${groupName}" with externalId for team ${team.id}`,
            {
              groupId: group.id,
              externalId,
            }
          );
        } else {
          // If not found at all, create a new group
          group = await Group.create(
            {
              name: groupName,
              teamId: team.id,
              externalId,
              createdById: user.id,
              description: `Automatically synchronized from ${authProviderName}`,
            },
            { transaction }
          );
          result.created.push(group);
          Logger.info(
            "groupSynchronizer",
            `Created new group "${groupName}" for team ${team.id}`,
            {
              groupId: group.id,
              externalId,
            }
          );
        }
      }

      return group;
    });

    const groups = await Promise.all(groupPromises);
    const groupIds = groups.map((g) => g.id);

    // Step 2: Add user to groups they should be in
    for (const group of groups) {
      const [, created] = await GroupUser.findOrCreate({
        where: {
          groupId: group.id,
          userId: user.id,
        },
        defaults: {
          groupId: group.id,
          userId: user.id,
          createdById: user.id,
          permission: GroupPermission.Member,
        },
        transaction,
      });

      if (created) {
        result.added.push(group);
        Logger.info(
          "groupSynchronizer",
          `Added user ${user.id} to group "${group.name}"`,
          {
            groupId: group.id,
            userId: user.id,
          }
        );
      }
    }

    // Step 3: Remove user from externally-managed groups they're no longer in
    // Only remove from groups that have an externalId starting with our auth provider
    const externalGroupsForProvider = await Group.findAll({
      where: {
        teamId: team.id,
        externalId: {
          [sequelize.Sequelize.Op.like]: `${authProviderName}:%`,
        },
      },
      transaction,
    });

    const groupsToRemoveFrom = externalGroupsForProvider.filter(
      (g) => !groupIds.includes(g.id)
    );

    for (const group of groupsToRemoveFrom) {
      const deleted = await GroupUser.destroy({
        where: {
          groupId: group.id,
          userId: user.id,
        },
        transaction,
      });

      if (deleted > 0) {
        result.removed.push(group);
        Logger.info(
          "groupSynchronizer",
          `Removed user ${user.id} from group "${group.name}"`,
          {
            groupId: group.id,
            userId: user.id,
          }
        );
      }
    }

    Logger.debug("groupSynchronizer", "Group synchronization complete", {
      userId: user.id,
      teamId: team.id,
      created: result.created.length,
      added: result.added.length,
      removed: result.removed.length,
    });

    return result;
  });
}

export default traceFunction({
  spanName: "groupSynchronizer",
})(groupSynchronizer);
