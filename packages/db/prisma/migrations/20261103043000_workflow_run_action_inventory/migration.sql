CREATE INDEX `ix_workflow_actions_run_inventory`
  ON `workflow_actions` (`org_id`, `workflow_id`, `run_id`, `action_id`);
