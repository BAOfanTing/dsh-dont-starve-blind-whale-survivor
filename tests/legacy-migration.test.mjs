import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SkillExecutor } from '../lib/skills/skill-executor.js';

describe('SkillExecutor Legacy Migration', () => {
  it('should migrate old skill_id keys to instance_id and remove old keys', () => {
    const memory = {
      skill_instances: {
        'gather_resources': { skill_id: 'gather_resources', status: 'in_progress', started_at: 123 }
      }
    };
    const executor = new SkillExecutor({ memory });
    
    // Trigger migration
    executor.allInstances();
    
    assert.strictEqual(memory.skill_instances.hasOwnProperty('gather_resources'), false, 'Should have removed legacy skill_id key');
    const instances = Object.values(memory.skill_instances);
    assert.strictEqual(instances.length, 1);
    assert.ok(instances[0].instance_id);
    assert.strictEqual(instances[0].instance_id, 'inst_gather_resources_123');
  });
});
